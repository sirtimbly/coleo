import type { Database } from 'bun:sqlite';

function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Ignore formatting and ordinary identifier quoting; preserve quoted contents and operators. */
export function schemaDefinition(sql: string | null): string {
  const tokens = (sql ?? '').match(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[\p{L}_][\p{L}\p{N}_$]*|\d+(?:\.\d+)?|[^\s]/gu) ?? [];
  return JSON.stringify(tokens.filter((token) => !token.startsWith('--') && !token.startsWith('/*')).map((token) => {
    if (token.startsWith("'")) return token;
    if (token.startsWith('"')) return token.slice(1, -1).replaceAll('""', '"');
    if (token.startsWith('`')) return token.slice(1, -1).replaceAll('``', '`');
    if (token.startsWith('[')) return token.slice(1, -1);
    return token.toLowerCase();
  }));
}

interface ForeignKey {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
  match: string;
}

export interface TableStructure {
  foreignKeys: string[];
  uniqueKeys: string[];
}

/** FK ids and SQLite autoindex names can change after additive migrations. */
export function tableStructure(db: Database, table: string): TableStructure {
  const foreignKeys = new Map<number, ForeignKey[]>();
  for (const row of db.query(`PRAGMA foreign_key_list(${identifier(table)})`).all() as ForeignKey[]) {
    const group = foreignKeys.get(row.id) ?? [];
    group.push(row);
    foreignKeys.set(row.id, group);
  }
  const indexes = db.query(`PRAGMA index_list(${identifier(table)})`).all() as Array<{ name: string; origin: string }>;
  return {
    foreignKeys: [...foreignKeys.values()].map((rows) => JSON.stringify(rows.sort((a, b) => a.seq - b.seq)
      .map(({ id: _id, ...row }) => row))),
    uniqueKeys: indexes.filter((index) => index.origin === 'u' || index.origin === 'pk').map((index) => {
      const columns = db.query(`PRAGMA index_xinfo(${identifier(index.name)})`).all() as Array<{
        seqno: number; name: string | null; desc: number; coll: string; key: number;
      }>;
      return JSON.stringify(columns.filter((column) => column.key).sort((a, b) => a.seqno - b.seqno)
        .map(({ name, desc, coll }) => ({ name, desc, coll })));
    }),
  };
}
