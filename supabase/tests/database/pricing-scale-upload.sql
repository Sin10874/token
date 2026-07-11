\set event_id random(1, 2147483647)
SELECT public.tokend_upload_events_v2(
  'scale-token',
  jsonb_build_array(jsonb_build_object(
    'id', 'v2-live-' || txid_current()::TEXT || '-' || :event_id::TEXT,
    'timestampMs', (extract(epoch FROM clock_timestamp()) * 1000)::BIGINT,
    'sessionId', 'scale-session-live',
    'model', 'gpt-5.6-sol',
    'inputTokens', 100,
    'outputTokens', 20,
    'reasoningTokens', 0,
    'cacheReadTokens', 10,
    'cacheWriteTokens', 5,
    'totalTokens', 135,
    'project', 'pricing-scale-live'
  )),
  '[]'::JSONB
);

