/**
 * GeoPackage: importar cualquier tabla de features y exportar el dibujo.
 *
 * IMPORTAR: cada tabla de `gpkg_contents` (data_type = features) pasa a ser una
 * capa vectorial. Las geometrías se llevan a UTM 19S desde el sistema que
 * declare la tabla (EPSG o WKT de `gpkg_spatial_ref_sys`) y los atributos
 * quedan en cada forma. Si el archivo trae estilo de QGIS (`layer_styles`) se
 * aplica: renderer, símbolos y etiquetado.
 *
 * EXPORTAR: una tabla por capa y tipo de geometría (un GeoPackage no mezcla
 * puntos, líneas y polígonos en la misma tabla), en EPSG:32719, con todos los
 * atributos, el nombre de cada forma y un campo `gd_style` que indexa su
 * estilo; el QML que se escribe en `layer_styles` categoriza por ese campo,
 * así QGIS abre el archivo con el mismo aspecto del dibujo.
 */

import { DOC_EPSG, DOC_WKT } from '../proj.js';
import { loadSql } from './loader.js';
import { toDocTransform } from './crs.js';
import { decodeGeoPackageBinary, encodeGeoPackageBinary } from './wkb.js';
import { geometryToShapes, guessName, layerFeatures } from './features.js';
import { buildCategorizedQML, parseQML, styleFor } from './qml.js';
import { defaultStyle } from '../style.js';

function rowsOf(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

const tableExists = (db, name) => rowsOf(db, `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [name]).length > 0;

const defaultStyles = () => ({
  point: { ...defaultStyle(), fill: '#e11d48', fillOpacity: 1, stroke: '#ffffff', strokeWidth: 0.25, pointShape: 'circle', pointSize: 2.2 },
  line: { ...defaultStyle(), stroke: '#1e3a8a', strokeWidth: 0.35 },
  polygon: { ...defaultStyle(), fill: '#a3e635', fillOpacity: 0.35, stroke: '#3f6212', strokeWidth: 0.25, align: 'outside' },
});

export async function importGeoPackage(arrayBuffer, { refScale = 25000 } = {}) {
  const SQL = await loadSql();
  const db = new SQL.Database(new Uint8Array(arrayBuffer));
  const layers = [];
  const warnings = [];
  try {
    if (!tableExists(db, 'gpkg_contents')) throw new Error('El archivo no parece un GeoPackage (falta gpkg_contents)');
    const contents = rowsOf(db, `SELECT table_name, identifier, srs_id FROM gpkg_contents WHERE data_type = 'features'`);
    if (!contents.length) warnings.push('El GeoPackage no contiene tablas de features.');
    const hasStyles = tableExists(db, 'layer_styles');

    for (const c of contents) {
      const table = c.table_name;
      const gc = rowsOf(db, `SELECT column_name, geometry_type_name, srs_id FROM gpkg_geometry_columns WHERE table_name = ?`, [table])[0];
      if (!gc) {
        warnings.push(`«${table}» no declara columna de geometría; se omite.`);
        continue;
      }
      const srsId = Number(gc.srs_id ?? c.srs_id ?? 4326);
      const srs = rowsOf(db, `SELECT organization, organization_coordsys_id, definition FROM gpkg_spatial_ref_sys WHERE srs_id = ?`, [srsId])[0];
      let T;
      try {
        const code = srs && String(srs.organization).toUpperCase() === 'EPSG' ? Number(srs.organization_coordsys_id) : srsId;
        T = await toDocTransform(code > 0 ? code : srs?.definition);
      } catch {
        try {
          T = await toDocTransform(srs?.definition);
        } catch (err) {
          warnings.push(`«${table}»: ${err.message}`);
          continue;
        }
      }

      let rules = null;
      let labels = null;
      if (hasStyles) {
        const st = rowsOf(db, `SELECT styleQML FROM layer_styles WHERE f_table_name = ? ORDER BY useAsDefault DESC, id ASC`, [table])[0];
        if (st?.styleQML) {
          try {
            const parsed = parseQML(st.styleQML, { refScale });
            rules = parsed.rules;
            labels = parsed.labels;
            for (const w of parsed.warnings) warnings.push(`«${table}»: ${w}`);
          } catch (err) {
            warnings.push(`«${table}»: no se pudo leer el estilo QGIS (${err.message})`);
          }
        }
      }

      const geomCol = gc.column_name;
      const rows = rowsOf(db, `SELECT * FROM "${table}"`);
      const shapes = [];
      const fields = new Set();
      const base = defaultStyles();
      let bad = 0;
      for (const row of rows) {
        const blob = row[geomCol];
        if (!blob) continue;
        let geometry;
        try {
          geometry = decodeGeoPackageBinary(blob);
        } catch {
          bad++;
          continue;
        }
        if (!geometry) continue;
        const attrs = {};
        for (const [k, v] of Object.entries(row)) {
          if (k === geomCol || k === 'gd_style' || k === 'gd_style_json' || k === 'gd_name' || k === 'gd_text' || k === 'fid') continue;
          attrs[k] = v instanceof Uint8Array ? null : v;
          fields.add(k);
        }
        // las reglas pueden depender de campos que no se guardan como atributo (gd_style)
        const ruled = rules ? styleFor(rules, { ...row, ...attrs }) : null;
        // un GeoPackage hecho por GISDrawer trae el estilo completo (ornamentos,
        // tramas, ondulados…) en gd_style_json: manda sobre lo que se pueda leer del QML
        let own = null;
        if (row.gd_style_json) {
          try {
            own = { ...defaultStyle(), ...JSON.parse(row.gd_style_json) };
          } catch {
            own = null;
          }
        }
        const styles = own ? { point: own, line: own, polygon: own } : ruled ? { point: ruled, line: ruled, polygon: ruled } : base;
        for (const s of geometryToShapes(geometry, attrs, T, styles)) {
          s.name = row.gd_name || guessName(attrs, s.name);
          if (s.style) s.style = { ...defaultStyle(), ...s.style };
          shapes.push(s);
        }
      }
      if (bad) warnings.push(`«${table}»: ${bad} geometría(s) ilegible(s) omitida(s).`);
      layers.push({ name: c.identifier || table, items: shapes, fields: [...fields], labels, srsId });
    }
  } finally {
    db.close();
  }
  return { layers, warnings };
}

/* ================================================================ exportar */

const SCHEMA = `
PRAGMA application_id = 1196444487;
PRAGMA user_version = 10300;
CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY, organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT);
CREATE TABLE gpkg_contents (table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '', last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER);
CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL, CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name));
CREATE TABLE layer_styles (id INTEGER PRIMARY KEY AUTOINCREMENT, f_table_catalog TEXT, f_table_schema TEXT, f_table_name TEXT, f_geometry_column TEXT, styleName TEXT, styleQML TEXT, styleSLD TEXT, useAsDefault BOOLEAN, description TEXT, owner TEXT, ui TEXT, update_time DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
INSERT INTO gpkg_spatial_ref_sys VALUES ('Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', '');
INSERT INTO gpkg_spatial_ref_sys VALUES ('Undefined geographic SRS', 0, 'NONE', 0, 'undefined', '');
`;

const GEOM_NAME = { point: 'POINT', line: 'LINESTRING', polygon: 'POLYGON' };
const SUFFIX = { point: 'puntos', line: 'lineas', polygon: 'poligonos' };

export function sanitizeTableName(name) {
  const s = String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return /^[a-z_]/.test(s) ? s || 'capa' : `c_${s}`;
}

/** Exporta las capas vectoriales a un GeoPackage (Uint8Array). */
export async function exportGeoPackage(doc, { layerIds = null, tol = 0.1 } = {}) {
  const SQL = await loadSql();
  const db = new SQL.Database();
  db.exec(SCHEMA);
  db.run('INSERT INTO gpkg_spatial_ref_sys VALUES (?,?,?,?,?,?)', ['WGS 84 / UTM zone 19S', DOC_EPSG, 'EPSG', DOC_EPSG, DOC_WKT, '']);
  const used = new Set();
  let tables = 0;
  for (const layer of doc.layers) {
    if (layer.kind !== 'vector' || (layerIds && !layerIds.includes(layer.id))) continue;
    const feats = layerFeatures(layer, tol);
    const kinds = [...new Set(feats.map((f) => f.kind))];
    for (const kind of kinds) {
      const subset = feats.filter((f) => f.kind === kind);
      let table = sanitizeTableName(kinds.length > 1 ? `${layer.name}_${SUFFIX[kind]}` : layer.name);
      while (used.has(table)) table += '_';
      used.add(table);
      const fieldSet = new Set();
      for (const f of subset) for (const k of Object.keys(f.shape.attrs || {})) fieldSet.add(k);
      const fields = [...fieldSet].filter((k) => !['fid', 'geom', 'gd_style', 'gd_style_json', 'gd_name', 'gd_text'].includes(k.toLowerCase()));
      const types = fields.map((k) => (subset.every((f) => f.shape.attrs?.[k] == null || typeof f.shape.attrs[k] === 'number') ? 'REAL' : 'TEXT'));
      const cols = fields.map((k, i) => `"${k.replace(/"/g, '')}" ${types[i]}`);
      db.exec(
        `CREATE TABLE "${table}" (fid INTEGER PRIMARY KEY AUTOINCREMENT, geom ${GEOM_NAME[kind]}, gd_name TEXT, gd_style TEXT, gd_style_json TEXT, gd_text TEXT${cols.length ? `, ${cols.join(', ')}` : ''})`,
      );
      // estilos distintos -> índice
      const styles = [];
      const keyOf = new Map();
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const stmt = db.prepare(
        `INSERT INTO "${table}" (geom, gd_name, gd_style, gd_style_json, gd_text${fields.length ? `, ${fields.map((k) => `"${k.replace(/"/g, '')}"`).join(', ')}` : ''}) VALUES (?, ?, ?, ?, ?${', ?'.repeat(fields.length)})`,
      );
      for (const f of subset) {
        const st = f.shape.style || {};
        const k = JSON.stringify(st);
        if (!keyOf.has(k)) {
          keyOf.set(k, styles.length);
          styles.push(st);
        }
        const flat = f.geometry.type === 'Point' ? [f.geometry.coordinates] : f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates.flat();
        for (const [x, y] of flat) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
        stmt.run([
          encodeGeoPackageBinary(f.geometry, DOC_EPSG),
          f.shape.name || null,
          String(keyOf.get(k)),
          k,
          f.shape.type === 'text' ? f.shape.text : null,
          ...fields.map((fl) => {
            const v = f.shape.attrs?.[fl];
            return v == null ? null : typeof v === 'number' ? v : String(v);
          }),
        ]);
      }
      stmt.free();
      db.run('INSERT INTO gpkg_contents (table_name, data_type, identifier, min_x, min_y, max_x, max_y, srs_id) VALUES (?,?,?,?,?,?,?,?)', [
        table,
        'features',
        kinds.length > 1 ? `${layer.name} (${SUFFIX[kind]})` : layer.name,
        minX,
        minY,
        maxX,
        maxY,
        DOC_EPSG,
      ]);
      db.run('INSERT INTO gpkg_geometry_columns VALUES (?,?,?,?,0,0)', [table, 'geom', GEOM_NAME[kind], DOC_EPSG]);
      db.run(
        'INSERT INTO layer_styles (f_table_name, f_geometry_column, styleName, styleQML, styleSLD, useAsDefault, description) VALUES (?,?,?,?,?,1,?)',
        [table, 'geom', layer.name, buildCategorizedQML(styles, kind, layer.labels), '', 'GISDrawer'],
      );
      tables++;
    }
  }
  if (!tables) {
    db.close();
    throw new Error('No hay elementos vectoriales para exportar');
  }
  const bytes = db.export();
  db.close();
  return bytes;
}
