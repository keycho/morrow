-- pool addresses are discovered from the uniswap v3 factory, not known at
-- token-registration time. a token can be tracked (anchors, proxies) before
-- its pool is selected, so pool_address becomes nullable. additive: relaxes a
-- constraint, no data rewrite.

alter table tokens
  alter column pool_address drop not null;
