import { ident, literal } from 'pg-format'
import PostgresMetaTables from './PostgresMetaTables'
import { DEFAULT_SYSTEM_SCHEMAS } from './constants'
import { columnsSql } from './sql'
import { PostgresMetaResult, PostgresColumn } from './types'

// TODO: Fix handling of `type` in `create()` and `update()`.
// `type` on its own is not enough, e.g. `1::my type` should be `1::"my type"`.
// `ident(type)` is not enough, e.g. `"int2[]"` should be `"int2"[]`.
export default class PostgresMetaColumns {
  query: (sql: string) => Promise<PostgresMetaResult<any>>
  metaTables: PostgresMetaTables

  constructor(query: (sql: string) => Promise<PostgresMetaResult<any>>) {
    this.query = query
    this.metaTables = new PostgresMetaTables(query)
  }

  async list({
    includeSystemSchemas = false,
    limit,
    offset,
  }: {
    includeSystemSchemas?: boolean
    limit?: number
    offset?: number
  } = {}): Promise<PostgresMetaResult<PostgresColumn[]>> {
    let sql = columnsSql
    if (!includeSystemSchemas) {
      sql = `${sql} AND NOT (nc.nspname IN (${DEFAULT_SYSTEM_SCHEMAS.map(literal).join(',')}))`
    }
    if (limit) {
      sql = `${sql} LIMIT ${limit}`
    }
    if (offset) {
      sql = `${sql} OFFSET ${offset}`
    }
    return await this.query(sql)
  }

  async retrieve({ id }: { id: string }): Promise<PostgresMetaResult<PostgresColumn>>
  async retrieve({
    name,
    table,
    schema,
  }: {
    name: string
    table: string
    schema: string
  }): Promise<PostgresMetaResult<PostgresColumn>>
  async retrieve({
    id,
    name,
    table,
    schema = 'public',
  }: {
    id?: string
    name?: string
    table?: string
    schema?: string
  }): Promise<PostgresMetaResult<PostgresColumn>> {
    if (id) {
      const regexp = /^(\d+)\.(\d+)$/
      if (!regexp.test(id)) {
        return { data: null, error: { message: 'Invalid format for column ID' } }
      }
      const matches = id.match(regexp) as RegExpMatchArray
      const [tableId, ordinalPos] = matches.slice(1).map(Number)
      const sql = `${columnsSql} AND c.oid = ${tableId} AND a.attnum = ${ordinalPos};`
      const { data, error } = await this.query(sql)
      if (error) {
        return { data, error }
      } else if (data.length === 0) {
        return { data: null, error: { message: `Cannot find a column with ID ${id}` } }
      } else {
        return { data: data[0], error }
      }
    } else if (name && table) {
      const sql = `${columnsSql} AND a.attname = ${literal(name)} AND c.relname = ${literal(
        table
      )} AND nc.nspname = ${literal(schema)};`
      const { data, error } = await this.query(sql)
      if (error) {
        return { data, error }
      } else if (data.length === 0) {
        return {
          data: null,
          error: { message: `Cannot find a column named ${name} in table ${schema}.${table}` },
        }
      } else {
        return { data: data[0], error }
      }
    } else {
      return { data: null, error: { message: 'Invalid parameters on column retrieve' } }
    }
  }

  async create({
    table_id,
    name,
    type,
    default_value,
    default_value_format = 'literal',
    is_identity = false,
    identity_generation = 'BY DEFAULT',
    // Can't pick a value as default since regular columns are nullable by default but PK columns aren't
    is_nullable,
    is_primary_key = false,
    is_unique = false,
    comment,
    check,
  }: {
    table_id: number
    name: string
    type: string
    default_value?: any
    default_value_format?: 'expression' | 'literal'
    is_identity?: boolean
    identity_generation?: 'BY DEFAULT' | 'ALWAYS'
    is_nullable?: boolean
    is_primary_key?: boolean
    is_unique?: boolean
    comment?: string
    check?: string
  }): Promise<PostgresMetaResult<PostgresColumn>> {
    const { data, error } = await this.metaTables.retrieve({ id: table_id })
    if (error) {
      return { data: null, error }
    }
    const { name: table, schema } = data!

    let defaultValueClause = ''
    if (is_identity) {
      if (default_value !== undefined) {
        return {
          data: null,
          error: { message: 'Columns cannot both be identity and have a default value' },
        }
      }

      defaultValueClause = `GENERATED ${identity_generation} AS IDENTITY`
    } else {
      if (default_value === undefined) {
        // skip
      } else if (default_value_format === 'expression') {
        defaultValueClause = `DEFAULT ${default_value}`
      } else {
        defaultValueClause = `DEFAULT ${literal(default_value)}`
      }
    }

    let isNullableClause = ''
    if (is_nullable !== undefined) {
      isNullableClause = is_nullable ? 'NULL' : 'NOT NULL'
    }
    const isPrimaryKeyClause = is_primary_key ? 'PRIMARY KEY' : ''
    const isUniqueClause = is_unique ? 'UNIQUE' : ''
    const checkSql = check === undefined ? '' : `CHECK (${check})`
    const commentSql =
      comment === undefined
        ? ''
        : `COMMENT ON COLUMN ${ident(schema)}.${ident(table)}.${ident(name)} IS ${literal(comment)}`

    const sql = `
BEGIN;
  ALTER TABLE ${ident(schema)}.${ident(table)} ADD COLUMN ${ident(name)} ${type}
    ${defaultValueClause}
    ${isNullableClause}
    ${isPrimaryKeyClause}
    ${isUniqueClause}
    ${checkSql};
  ${commentSql};
COMMIT;`
    {
      const { error } = await this.query(sql)
      if (error) {
        return { data: null, error }
      }
    }
    return await this.retrieve({ name, table, schema })
  }

  async update(
    id: string,
    {
      name,
      type,
      drop_default = false,
      default_value,
      default_value_format = 'literal',
      is_identity,
      identity_generation = 'BY DEFAULT',
      is_nullable,
      is_unique,
      comment,
    }: {
      name?: string
      type?: string
      drop_default?: boolean
      default_value?: any
      default_value_format?: 'expression' | 'literal'
      is_identity?: boolean
      identity_generation?: 'BY DEFAULT' | 'ALWAYS'
      is_nullable?: boolean
      is_unique?: boolean
      comment?: string
    }
  ): Promise<PostgresMetaResult<PostgresColumn>> {
    const { data: old, error } = await this.retrieve({ id })
    if (error) {
      return { data: null, error }
    }

    const nameSql =
      name === undefined || name === old!.name
        ? ''
        : `ALTER TABLE ${ident(old!.schema)}.${ident(old!.table)} RENAME COLUMN ${ident(
            old!.name
          )} TO ${ident(name)};`
    // We use USING to allow implicit conversion of incompatible types (e.g. int4 -> text).
    const typeSql =
      type === undefined
        ? ''
        : `ALTER TABLE ${ident(old!.schema)}.${ident(old!.table)} ALTER COLUMN ${ident(
            old!.name
          )} SET DATA TYPE ${ident(type)} USING ${ident(old!.name)}::${ident(type)};`

    let defaultValueSql: string
    if (drop_default) {
      defaultValueSql = `ALTER TABLE ${ident(old!.schema)}.${ident(
        old!.table
      )} ALTER COLUMN ${ident(old!.name)} DROP DEFAULT;`
    } else if (default_value === undefined) {
      defaultValueSql = ''
    } else {
      const defaultValue =
        default_value_format === 'expression' ? default_value : literal(default_value)
      defaultValueSql = `ALTER TABLE ${ident(old!.schema)}.${ident(
        old!.table
      )} ALTER COLUMN ${ident(old!.name)} SET DEFAULT ${defaultValue};`
    }
    // What identitySql does vary depending on the old and new values of
    // is_identity and identity_generation.
    //
    // | is_identity: old \ new | undefined          | true               | false          |
    // |------------------------+--------------------+--------------------+----------------|
    // | true                   | maybe set identity | maybe set identity | drop if exists |
    // |------------------------+--------------------+--------------------+----------------|
    // | false                  | -                  | add identity       | drop if exists |
    let identitySql = `ALTER TABLE ${ident(old!.schema)}.${ident(old!.table)} ALTER COLUMN ${ident(
      old!.name
    )}`
    if (is_identity === false) {
      identitySql += ' DROP IDENTITY IF EXISTS;'
    } else if (old!.is_identity === true) {
      if (identity_generation === undefined) {
        identitySql = ''
      } else {
        identitySql += ` SET GENERATED ${identity_generation};`
      }
    } else if (is_identity === undefined) {
      identitySql = ''
    } else {
      identitySql += ` ADD GENERATED ${identity_generation} AS IDENTITY;`
    }
    let isNullableSql: string
    if (is_nullable === undefined) {
      isNullableSql = ''
    } else {
      isNullableSql = is_nullable
        ? `ALTER TABLE ${ident(old!.schema)}.${ident(old!.table)} ALTER COLUMN ${ident(
            old!.name
          )} DROP NOT NULL;`
        : `ALTER TABLE ${ident(old!.schema)}.${ident(old!.table)} ALTER COLUMN ${ident(
            old!.name
          )} SET NOT NULL;`
    }
    let isUniqueSql = ''
    if (old!.is_unique === true && is_unique === false) {
      isUniqueSql = `
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint WHERE
      contype = 'u'
      AND cardinality(conkey) = 1
      AND conrelid = ${literal(old!.table_id)}
      AND conkey[1] = ${literal(old!.ordinal_position)}
  LOOP
    EXECUTE ${literal(
      `ALTER TABLE ${ident(old!.schema)}.${ident(old!.table)} DROP CONSTRAINT `
    )} || quote_ident(r.conname);
  END LOOP;
END
$$;
`
    } else if (old!.is_unique === false && is_unique === true) {
      isUniqueSql = `ALTER TABLE ${ident(old!.schema)}.${ident(old!.table)} ADD UNIQUE (${ident(
        old!.name
      )});`
    }
    const commentSql =
      comment === undefined
        ? ''
        : `COMMENT ON COLUMN ${ident(old!.schema)}.${ident(old!.table)}.${ident(
            old!.name
          )} IS ${literal(comment)};`

    // TODO: Can't set default if column is previously identity even if
    // is_identity: false. Must do two separate PATCHes (once to drop identity
    // and another to set default).
    // NOTE: nameSql must be last. defaultValueSql must be after typeSql.
    // identitySql must be after isNullableSql.
    const sql = `
BEGIN;
  ${isNullableSql}
  ${typeSql}
  ${defaultValueSql}
  ${identitySql}
  ${isUniqueSql}
  ${commentSql}
  ${nameSql}
COMMIT;`
    {
      const { error } = await this.query(sql)
      if (error) {
        return { data: null, error }
      }
    }
    return await this.retrieve({ id })
  }

  async remove(id: string): Promise<PostgresMetaResult<PostgresColumn>> {
    const { data: column, error } = await this.retrieve({ id })
    if (error) {
      return { data: null, error }
    }
    const sql = `ALTER TABLE ${ident(column!.schema)}.${ident(column!.table)} DROP COLUMN ${ident(
      column!.name
    )};`
    {
      const { error } = await this.query(sql)
      if (error) {
        return { data: null, error }
      }
    }
    return { data: column!, error: null }
  }
}
