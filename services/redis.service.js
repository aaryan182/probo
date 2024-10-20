const redis = require("redis");
const { promisify } = require("util");

const client = redis.createClient({
  host: process.env.REDIS_HOST || "localhost",
  port: process.env.REDIS_PORT || 6379,
});

const subscriberClient = redis.createClient({
  host: process.env.REDIS_HOST || "localhost",
  port: process.env.REDIS_PORT || 6379,
});

client.on("error", (err) => console.log("Redis Client Error", err));
subscriberClient.on("error", (err) =>
  console.log("Redis Subscriber Client Error", err)
);

const asyncHset = promisify(client.hset).bind(client);
const asyncHget = promisify(client.hget).bind(client);
const asyncHgetall = promisify(client.hgetall).bind(client);
const asyncHdel = promisify(client.hdel).bind(client);
const asyncPublish = promisify(client.publish).bind(client);
const asyncRpush = promisify(client.rpush).bind(client);
const asyncBlpop = promisify(client.blpop).bind(client);

const redisService = {
  hset: async (key, field, value) => {
    const stringValue =
      typeof value === "string" ? value : JSON.stringify(value);
    return await asyncHset(key, field, stringValue);
  },
  hget: async (key, field) => {
    const value = await asyncHget(key, field);
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  },
  hgetall: async (key) => {
    const result = await asyncHgetall(key);
    if (result) {
      Object.keys(result).forEach((field) => {
        try {
          result[field] = JSON.parse(result[field]);
        } catch {}
      });
    }
    return result;
  },
  hdel: async (key, field) => {
    return await asyncHdel(key, field);
  },
  publish: async (channel, message) => {
    const stringMessage =
      typeof message === "string" ? message : JSON.stringify(message);
    return await asyncPublish(channel, stringMessage);
  },
  subscribe: (channel, callback) => {
    subscriberClient.subscribe(channel);
    subscriberClient.on("message", (ch, message) => {
      if (ch === channel) {
        try {
          callback(JSON.parse(message));
        } catch {
          callback(message);
        }
      }
    });
  },
  unsubscribe: (channel) => {
    subscriberClient.unsubscribe(channel);
  },
  rpush: async (key, value) => {
    const stringValue =
      typeof value === "string" ? value : JSON.stringify(value);
    return await asyncRpush(key, stringValue);
  },
  blpop: async (key, timeout) => {
    const result = await asyncBlpop(key, timeout);
    if (result) {
      try {
        return JSON.parse(result[1]);
      } catch {
        return result[1];
      }
    }
    return null;
  },
};

module.exports = redisService;
