-- read-path indexes, built with create index concurrently after the bulk window
-- backfill so index maintenance never slows the write-bound load. applied by
-- `pnpm indexes:create` and removed by `pnpm indexes:drop`. this file is not run
-- by the migration runner (concurrently cannot run inside a transaction).

-- home page: latest blocks first.
create index concurrently if not exists blocks_timestamp_desc_idx
  on blocks (timestamp desc);

-- block page and home page: txs of a block, latest txs across all blocks.
create index concurrently if not exists transactions_block_idx
  on transactions (block_number desc, tx_index desc);

-- address page (sender side).
create index concurrently if not exists transactions_from_idx
  on transactions (from_address, block_number desc);

-- token page: transfers of a token, newest first.
create index concurrently if not exists token_transfers_token_idx
  on token_transfers (token_address, block_number desc);

-- address page: token movements in and out of an address.
create index concurrently if not exists token_transfers_from_idx
  on token_transfers (from_address);
create index concurrently if not exists token_transfers_to_idx
  on token_transfers (to_address);

-- address page: logs emitted by a contract, newest first.
create index concurrently if not exists logs_address_idx
  on logs (address, block_number desc);

-- address page: one index range read across both from and to directions.
create index concurrently if not exists address_transactions_addr_idx
  on address_transactions (address, block_number desc, tx_index desc);

-- pruner: range-delete address_transactions by block_number (its pk leads on
-- address, so a block_number delete would otherwise seq scan).
create index concurrently if not exists address_transactions_block_idx
  on address_transactions (block_number);
