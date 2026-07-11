\set event_id random(1, 2147483647)
INSERT INTO public.tokend_usage_events (
  id, member_code, timestamp_ms, session_id, model, channel,
  input_tokens, output_tokens, reasoning_tokens,
  cache_read_tokens, cache_write_tokens, total_tokens,
  input_cost, output_cost, reasoning_cost,
  cache_read_cost, cache_write_cost, total_cost, project
) VALUES (
  'legacy-live-' || txid_current()::TEXT || '-' || :event_id::TEXT,
  'SCALE001',
  (extract(epoch FROM clock_timestamp()) * 1000)::BIGINT,
  'scale-session-live',
  'gpt-5.6-sol',
  'scale-live',
  100, 20, 0, 10, 5, 135,
  0, 0, 0, 0, 0, 0,
  'pricing-scale-live'
);

