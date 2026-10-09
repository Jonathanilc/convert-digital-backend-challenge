/**
 * Lua scripts executed atomically on the Redis server. Each script performs the whole
 * read-modify-write for one request, so concurrent requests from many Node processes can
 * never over-admit, and each request costs a single round-trip.
 *
 * The current time is passed in by the caller (ARGV) rather than read via `TIME`: it keeps
 * every layer deterministic under an injected clock, so window expiry can be tested against a
 * real Redis without sleeping. Server-side TTLs are used only as garbage collection.
 *
 * Portability note: timestamps are formatted with `%.0f` so the scripts also behave on Lua VMs
 * with 32-bit integers (e.g. fengari-based emulators), which would wrap epoch milliseconds.
 */

/**
 * Fixed window. Hash `{ count, resetAt }` per key.
 * KEYS[1] key · ARGV[1] limit · ARGV[2] windowMs · ARGV[3] nowMs
 * Returns { count, resetMs }.
 */
export const FIXED_WINDOW_SCRIPT = `
local window = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local resetAt = tonumber(redis.call('HGET', KEYS[1], 'resetAt'))
local count
if not resetAt or resetAt <= now then
  resetAt = now + window
  redis.call('HSET', KEYS[1], 'count', 1, 'resetAt', string.format('%.0f', resetAt))
  count = 1
else
  count = redis.call('HINCRBY', KEYS[1], 'count', 1)
end
local resetMs = math.floor(resetAt - now)
-- Garbage collection: keep the hash a little past the window end so a late reader still
-- sees a consistent resetAt, then let Redis drop it.
redis.call('PEXPIRE', KEYS[1], resetMs + 1000)
return { count, resetMs }
`;

/**
 * Sliding log. Sorted set of allowed-request timestamps (score = ms) per key.
 * KEYS[1] key · ARGV[1] limit · ARGV[2] windowMs · ARGV[3] nowMs · ARGV[4] unique member id
 * Returns { allowed (0/1), count, resetMs }.
 */
export const SLIDING_LOG_SCRIPT = `
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', string.format('%.0f', now - window))

local count = redis.call('ZCARD', KEYS[1])
local allowed = 0
if count < limit then
  redis.call('ZADD', KEYS[1], string.format('%.0f', now), ARGV[4])
  count = count + 1
  allowed = 1
end

local resetMs = window
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if oldest[2] then
  resetMs = math.floor(tonumber(oldest[2]) + window - now)
  if resetMs < 1 then resetMs = 1 end
  redis.call('PEXPIRE', KEYS[1], resetMs)
else
  redis.call('DEL', KEYS[1])
end

return { allowed, count, resetMs }
`;
