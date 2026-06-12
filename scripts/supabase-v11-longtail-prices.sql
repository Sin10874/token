-- v11: 长尾模型价格补充（基于 v10 回填后全体用户的零成本模型清单）
--
-- 分四类：
--   A. 已知模型的 ID 写法变体（-thinking 后缀 / anthropic/ 前缀 / 大小写 / 渠道前缀）
--   B. 新模型（DeepSeek V4、MiMo、豆包 Seed 2.0、Qwen3.6、GPT-5.2 系、Gemini Flash 系）
--   C. 免费 / 订阅内置模型 → 显式 0 价（语义 = 确认无边际成本）
--   D. 伪 ID（unknown / auto / 隐身模型）→ 0 价
--
-- 执行顺序：
--   1. 跑本文件全部（秒级）
--   2. 重建临时索引（如已删）后反复 SELECT tokend_backfill_zero_costs_batch(50000); 至 repriced = 0
--   3. SELECT tokend_rebuild_session_costs();
--   4. 用文件末尾的验证查询确认无真缺价模型
--
-- 标注「近似」的行：官方未公布或分档复杂，按同系/同档模型近似，欢迎后续修正
-- （UPDATE tokend_model_prices SET ... WHERE model_id = '...' 即可，无需发版）

INSERT INTO tokend_model_prices
  (model_id, provider, input_price, output_price, cache_read_price, cache_write_price)
VALUES
  -- A. Claude 写法变体（价格同基础款）
  ('claude-sonnet-4.6',                   'anthropic', 3,     15,   0.3,   3.75),
  ('anthropic/claude-sonnet-4.6',         'anthropic', 3,     15,   0.3,   3.75),
  ('claude-sonnet-4-6-thinking',          'anthropic', 3,     15,   0.3,   3.75),
  ('anthropic/claude-4.6-sonnet-20260217','anthropic', 3,     15,   0.3,   3.75),
  ('claude-sonnet-4-5-thinking',          'anthropic', 3,     15,   0.3,   3.75),
  ('claude-opus-4-6-thinking',            'anthropic', 5,     25,   0.5,   6.25),
  ('claude-opus-4-5-20251101-thinking',   'anthropic', 5,     25,   0.5,   6.25),
  ('antigravity-claude-opus-4-5-thinking','anthropic', 5,     25,   0.5,   6.25),
  ('claude-haiku-4.5',                    'anthropic', 1,     5,    0.1,   1.25),
  ('anthropic/claude-haiku-4.5',          'anthropic', 1,     5,    0.1,   1.25),
  ('anthropic/claude-4.5-haiku-20251001', 'anthropic', 1,     5,    0.1,   1.25),
  ('claude-haiku-4-5-20251001-thinking',  'anthropic', 1,     5,    0.1,   1.25),
  -- B. DeepSeek
  ('deepseek-v4-pro',                     'deepseek',  1.74,  3.48, 0.145, 0),
  ('deepseek-v4-flash',                   'deepseek',  0.14,  0.28, 0.028, 0),
  ('deepseek-chat',                       'deepseek',  0.28,  0.42, 0.028, 0),
  ('deepseek-reasoner',                   'deepseek',  0.28,  0.42, 0.028, 0),
  -- B. 小米 MiMo
  ('mimo-v2.5-pro',                       'xiaomi',    0.435, 0.87, 0.004, 0),
  ('mimo-v2.5',                           'xiaomi',    0.435, 0.87, 0.004, 0),  -- 近似：按 v2.5-pro
  ('mimo-v2-pro',                         'xiaomi',    1,     3,    0.1,   0),  -- 近似：v2.5 降价前同档价
  ('mimo-v2-flash-free',                  'xiaomi',    0,     0,    0,     0),
  ('mimo-v2-pro-free',                    'xiaomi',    0,     0,    0,     0),
  -- B. 豆包 Seed 2.0（¥3.2/¥16 ≤32k 档折算）
  ('doubao-seed-2.0-pro',                 'bytedance', 0.47,  2.37, 0,     0),
  ('doubao-seed-2.0-code',                'bytedance', 0.47,  2.37, 0,     0),  -- 近似：按 pro 档
  -- B. MiniMax 补充
  ('MiniMax-M2.5',                        'minimax',   0.15,  0.9,  0.03,  0),
  ('Pro/MiniMaxAI/MiniMax-M2.5',          'minimax',   0.15,  0.9,  0.03,  0),
  ('MiniMax-M2.1',                        'minimax',   0.3,   1.2,  0.03,  0),
  ('MiniMax-M2',                          'minimax',   0.3,   1.2,  0.03,  0),
  ('MiniMax-M2.7-highspeed',              'minimax',   0.6,   2.4,  0.06,  0.375),
  ('minimax-m2.7',                        'minimax',   0.3,   1.2,  0.06,  0.375),
  ('zhanlu/minimax-2.7',                  'minimax',   0.3,   1.2,  0.06,  0.375),
  ('minimax-m2.5-free',                   'minimax',   0,     0,    0,     0),
  ('minimax/minimax-m2.5:free',           'minimax',   0,     0,    0,     0),
  -- B. GLM 变体
  ('Pro/zai-org/GLM-5',                   'zhipu',     1,     3.2,  0.2,   0),
  ('GLM-5.1',                             'zhipu',     1.4,   4.4,  0.26,  0),
  ('zhanlu/glm-4.7',                      'zhipu',     0.6,   2.2,  0.11,  0),
  ('glm-5-free',                          'zhipu',     0,     0,    0,     0),
  -- B. Qwen
  ('qwen3-coder-plus',                    'alibaba',   1.5,   7.5,  0.15,  0),
  ('qwen3.6-plus',                        'alibaba',   0.325, 1.95, 0.03,  0),
  ('qwen3.6-35b-a3b',                     'alibaba',   0.1,   0.4,  0.01,  0),  -- 近似：第三方托管均价
  ('zhanlu/qwen3.6-35b-a3b',              'alibaba',   0.1,   0.4,  0.01,  0),
  -- B. OpenAI 补充
  ('gpt-5.2',                             'openai',    1.75,  14,   0.175, 0),
  ('gpt-5.2-codex',                       'openai',    1.75,  14,   0.175, 0),
  ('gpt-5.2-xhigh',                       'openai',    1.75,  14,   0.175, 0),
  ('gpt-5.4-xhigh',                       'openai',    2.5,   15,   0.25,  0),
  ('gpt-5.4-mini',                        'openai',    0.5,   4,    0.05,  0),  -- 近似：按 mini 系惯例 1/5 档
  ('gpt-5.1-codex-mini',                  'openai',    0.25,  2,    0.025, 0),
  ('gpt-5-nano',                          'openai',    0.05,  0.4,  0.005, 0),
  ('gpt-image-2',                         'openai',    0,     0,    0,     0),  -- 图像模型，token 计价不适用
  -- B. Gemini 补充
  ('gemini-3-flash-preview',              'google',    0.5,   3,    0.05,  0),
  ('gemini-3-flash',                      'google',    0.5,   3,    0.05,  0),
  ('gemini-3.1-pro-preview',              'google',    2,     12,   0.2,   0),
  ('gemini-3.1-flash-lite-preview',       'google',    0.25,  1.5,  0.025, 0),
  ('gemini-3.5-flash',                    'google',    1.5,   9,    0.15,  0),
  -- B. xAI
  ('grok-4.1',                            'xai',       0.2,   0.5,  0.05,  0),
  ('x-ai/grok-code-fast-1',               'xai',       0.2,   1.5,  0.02,  0),
  -- B/C. Kimi 变体
  ('Kimi-K2.5',                           'moonshot',  0.6,   3,    0.1,   0),
  ('kimi-code',                           'moonshot',  0.6,   3,    0.1,   0),  -- 订阅渠道，等效 API 价
  ('kimi-k2.5-free',                      'moonshot',  0,     0,    0,     0),
  -- C/D. 免费 / 订阅内置 / 伪 ID → 显式 0
  ('unknown',                             'unknown',   0,     0,    0,     0),
  ('auto',                                'unknown',   0,     0,    0,     0),
  ('big-pickle',                          'unknown',   0,     0,    0,     0),  -- OpenRouter 隐身免费模型
  ('trinity-large-preview-free',          'unknown',   0,     0,    0,     0),
  ('astron-code-latest',                  'iflytek',   0,     0,    0,     0),  -- 订阅渠道，无公开 token 价
  ('ark-code-latest',                     'bytedance', 0,     0,    0,     0)   -- 订阅渠道，无公开 token 价
ON CONFLICT (model_id) DO UPDATE SET
  provider          = EXCLUDED.provider,
  input_price       = EXCLUDED.input_price,
  output_price      = EXCLUDED.output_price,
  cache_read_price  = EXCLUDED.cache_read_price,
  cache_write_price = EXCLUDED.cache_write_price,
  updated_at        = now();

-- 验证：真正还缺价格的模型（排除已定价含 0 价的）
-- SELECT e.model, COUNT(*) AS cnt
-- FROM tokend_usage_events e
-- WHERE e.total_cost = 0 AND e.total_tokens > 0
--   AND NOT EXISTS (
--     SELECT 1 FROM tokend_model_prices p
--     WHERE p.model_id = e.model
--        OR (e.model ~ '-\d{8,}$' AND p.model_id = regexp_replace(e.model, '-\d{8,}$', ''))
--   )
-- GROUP BY e.model ORDER BY cnt DESC;
