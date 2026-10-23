import { describe, expect, it } from 'vitest'
import type { TriggerInfo } from '../api'
import {
  dollarQuote,
  dropTriggerStatement,
  mysqlTriggerState,
  newTriggerDraft,
  pgTriggerState,
  triggerDraftFrom,
  triggerStatements,
  tsqlTriggerState,
  validateTrigger,
  type TriggerTarget
} from '../triggers'

const target: TriggerTarget = { schema: 'public', table: 'orders', isView: false }
const msTarget: TriggerTarget = { schema: 'dbo', table: 'orders', isView: false }

const info = (patch: Partial<TriggerInfo> = {}): TriggerInfo => ({
  name: 'audit',
  timing: 'AFTER',
  events: ['INSERT', 'UPDATE'],
  rowLevel: true,
  enabled: true,
  definition: null,
  ...patch
})

const pgExisting = () =>
  triggerDraftFrom(
    pgTriggerState(info(), {
      functionSchema: 'public',
      functionName: 'log_change',
      language: 'plpgsql',
      source: 'BEGIN\n  RETURN NULL;\nEND;',
      updateColumns: [],
      definition:
        "CREATE TRIGGER audit AFTER INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION log_change('orders')"
    })
  )

describe('PostgreSQL triggers', () => {
  it('creates a function and the trigger', () => {
    const d = { ...newTriggerDraft('postgres', target), name: 'stamp', timing: 'BEFORE' as const }
    d.events = ['INSERT', 'UPDATE']
    d.updateColumns = ['status']
    d.condition = 'NEW.status IS NOT NULL'
    expect(triggerStatements('postgres', d, target)).toEqual([
      `CREATE OR REPLACE FUNCTION public.orders_stamp_fn()\nRETURNS trigger\nLANGUAGE plpgsql\nAS $$\n${d.body}\n$$`,
      'CREATE TRIGGER stamp\nBEFORE INSERT OR UPDATE OF status\nON public.orders\nFOR EACH ROW\nWHEN (NEW.status IS NOT NULL)\nEXECUTE FUNCTION public.orders_stamp_fn()'
    ])
  })

  it('reads the WHEN condition from the definition', () => {
    const state = pgTriggerState(info(), {
      functionSchema: 'public',
      functionName: 'f',
      language: 'plpgsql',
      source: '',
      updateColumns: [],
      definition:
        'CREATE TRIGGER audit AFTER UPDATE ON orders FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION f()'
    })
    expect(state.condition).toBe('(old.* IS DISTINCT FROM new.*)')
    expect(state.functionArgs).toBe('')
  })

  it('keeps arguments and only renames when nothing else changed', () => {
    const d = pgExisting()
    expect(d.functionArgs).toBe("'orders'")
    expect(triggerStatements('postgres', d, target)).toEqual([])
    expect(triggerStatements('postgres', { ...d, name: 'audit2' }, target)).toEqual([
      'ALTER TRIGGER audit ON public.orders RENAME TO audit2'
    ])
    expect(triggerStatements('postgres', { ...d, enabled: false }, target)).toEqual([
      'ALTER TABLE public.orders DISABLE TRIGGER audit'
    ])
  })

  it('recreates the trigger when its firing changes and keeps it disabled', () => {
    const d = { ...pgExisting(), events: ['DELETE' as const], enabled: false }
    expect(triggerStatements('postgres', d, target)).toEqual([
      'DROP TRIGGER audit ON public.orders',
      "CREATE TRIGGER audit\nAFTER DELETE\nON public.orders\nFOR EACH ROW\nEXECUTE FUNCTION public.log_change('orders')",
      'ALTER TABLE public.orders DISABLE TRIGGER audit'
    ])
  })

  it('replaces the function when its body is edited', () => {
    const d = { ...pgExisting(), body: 'BEGIN\n  RETURN NEW;\nEND;' }
    expect(triggerStatements('postgres', d, target)).toEqual([
      'CREATE OR REPLACE FUNCTION public.log_change()\nRETURNS trigger\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RETURN NEW;\nEND;\n$$'
    ])
  })

  it('validates combinations PostgreSQL rejects', () => {
    const d = { ...newTriggerDraft('postgres', target), name: 't' }
    expect(validateTrigger('postgres', { ...d, events: ['TRUNCATE'] })).toMatch(/per statement/)
    expect(validateTrigger('postgres', { ...d, timing: 'INSTEAD OF', rowLevel: false })).toMatch(
      /for each row/
    )
    expect(validateTrigger('postgres', { ...d, events: [] })).toMatch(/event/)
    expect(validateTrigger('postgres', { ...d, name: ' ' })).toMatch(/Name/)
    expect(validateTrigger('postgres', d)).toBeNull()
  })

  it('picks a dollar-quote tag not in the body', () => {
    expect(dollarQuote('SELECT 1')).toBe('$$\nSELECT 1\n$$')
    expect(dollarQuote("SELECT $$x$$, '$fn$'")).toBe("$fn1$\nSELECT $$x$$, '$fn$'\n$fn1$")
  })
})

describe('MySQL triggers', () => {
  const myTarget: TriggerTarget = { schema: null, table: 'orders', isView: false }

  it('creates a trigger without doubling the final semicolon', () => {
    const d = { ...newTriggerDraft('mysql', myTarget), name: 'stamp', body: 'SET NEW.x = 1;' }
    expect(triggerStatements('mysql', d, myTarget)).toEqual([
      'CREATE TRIGGER `stamp`\nBEFORE INSERT ON `orders`\nFOR EACH ROW\nSET NEW.x = 1'
    ])
  })

  it('drops and recreates on any change', () => {
    const d = triggerDraftFrom(
      mysqlTriggerState(info({ timing: 'BEFORE', events: ['UPDATE'] }), 'SET NEW.x = 1')
    )
    expect(triggerStatements('mysql', d, myTarget)).toEqual([])
    expect(triggerStatements('mysql', { ...d, body: 'SET NEW.x = 2' }, myTarget)).toEqual([
      'DROP TRIGGER `audit`',
      'CREATE TRIGGER `audit`\nBEFORE UPDATE ON `orders`\nFOR EACH ROW\nSET NEW.x = 2'
    ])
    expect(dropTriggerStatement('mysql', 'audit', myTarget)).toBe('DROP TRIGGER `audit`')
  })
})

describe('T-SQL triggers', () => {
  const definition = `-- keeps history
CREATE TRIGGER [dbo].[audit] ON [dbo].[orders]
WITH EXECUTE AS OWNER
AFTER INSERT, UPDATE NOT FOR REPLICATION
AS
BEGIN
  SET NOCOUNT ON; -- AFTER DELETE AS in a comment
END
`

  it('splits an existing definition into header clauses and body', () => {
    const state = tsqlTriggerState(info({ rowLevel: false, definition }))
    expect(state).toMatchObject({
      withOptions: 'EXECUTE AS OWNER',
      notForReplication: true,
      body: 'BEGIN\n  SET NOCOUNT ON; -- AFTER DELETE AS in a comment\nEND'
    })
    expect(tsqlTriggerState(info({ definition: 'garbage' }))).toBeNull()
  })

  it('alters in place and recreates on rename', () => {
    const d = triggerDraftFrom(tsqlTriggerState(info({ rowLevel: false, definition }))!)
    expect(triggerStatements('tsql', d, msTarget)).toEqual([])
    expect(triggerStatements('tsql', { ...d, events: ['DELETE'] }, msTarget)).toEqual([
      'ALTER TRIGGER [dbo].[audit]\nON [dbo].[orders]\nWITH EXECUTE AS OWNER\nAFTER DELETE\nNOT FOR REPLICATION\nAS\nBEGIN\n  SET NOCOUNT ON; -- AFTER DELETE AS in a comment\nEND'
    ])
    const renamed = triggerStatements('tsql', { ...d, name: 'audit2', enabled: false }, msTarget)
    expect(renamed[0]).toBe('DROP TRIGGER [dbo].[audit]')
    expect(renamed[1]).toMatch(/^CREATE TRIGGER \[dbo\]\.\[audit2\]/)
    expect(renamed[2]).toBe('DISABLE TRIGGER [dbo].[audit2] ON [dbo].[orders]')
  })

  it('creates a new trigger', () => {
    const d = {
      ...newTriggerDraft('tsql', msTarget),
      name: 'stamp',
      timing: 'INSTEAD OF' as const,
      body: 'SELECT 1'
    }
    expect(triggerStatements('tsql', d, msTarget)).toEqual([
      'CREATE TRIGGER [dbo].[stamp]\nON [dbo].[orders]\nINSTEAD OF INSERT\nAS\nSELECT 1'
    ])
    expect(dropTriggerStatement('tsql', 'stamp', msTarget)).toBe('DROP TRIGGER [dbo].[stamp]')
  })
})
