-- migrate:up
-- Widen the free-form broker text columns on trade_executions. IBKR's
-- open/close field isn't always a single 'O'/'C' — it can carry a sub-code
-- (e.g. 'C;IA', a close with an IBKR adjustment), which overflowed varchar(1)
-- and crashed the import. Venue can be a multi-venue list (longer than 40 as a
-- fill fragments) and short-sale action codes run longer than 16, so convert
-- the whole class to text rather than guessing widths. These columns are
-- descriptive metadata — the P&L matcher keys off signed quantity, not these —
-- so widening is purely a storage-fidelity fix.
alter table trade_executions
  alter column open_close type text,
  alter column action_raw type text,
  alter column venue      type text,
  alter column side       type text;

-- migrate:down
alter table trade_executions
  alter column open_close type varchar(1),
  alter column action_raw type varchar(16),
  alter column venue      type varchar(40),
  alter column side       type varchar(4);
