const redis = require("redis");
const { promisify } = require("util");

class RedisService {
  constructor() {
    this.client = redis.createClient({
      host: process.env.REDIS_HOST || "localhost",
      port: process.env.REDIS_PORT || 6379,
    });

    this.subscriberClient = redis.createClient({
      host: process.env.REDIS_HOST || "localhost",
      port: process.env.REDIS_PORT || 6379,
    });

    this.client.on("error", (err) => console.log("Redis Client Error", err));
    this.subscriberClient.on("error", (err) =>
      console.log("Redis Subscriber Client Error", err)
    );

    this.asyncHset = promisify(this.client.hset).bind(this.client);
    this.asyncHget = promisify(this.client.hget).bind(this.client);
    this.asyncHgetall = promisify(this.client.hgetall).bind(this.client);
    this.asyncHdel = promisify(this.client.hdel).bind(this.client);
    this.asyncPublish = promisify(this.client.publish).bind(this.client);
  }

  async hset(key, field, value) {
    const stringValue =
      typeof value === "string" ? value : JSON.stringify(value);
    return await this.asyncHset(key, field, stringValue);
  }

  async hget(key, field) {
    const value = await this.asyncHget(key, field);
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  async hgetall(key) {
    const result = await this.asyncHgetall(key);
    if (result) {
      Object.keys(result).forEach((field) => {
        try {
          result[field] = JSON.parse(result[field]);
        } catch {}
      });
    }
    return result;
  }

  async hdel(key, field) {
    return await this.asyncHdel(key, field);
  }

  async publish(channel, message) {
    if (channel === "updates") {
      const formattedMessage = {
        event: "event_orderbook_update",
        message: JSON.stringify(message),
      };
      return await this.asyncPublish(channel, JSON.stringify(formattedMessage));
    }
    return await this.asyncPublish(
      channel,
      typeof message === "string" ? message : JSON.stringify(message)
    );
  }

  subscribe(channel, callback) {
    this.subscriberClient.subscribe(channel);
    this.subscriberClient.on("message", (ch, message) => {
      if (ch === channel) {
        try {
          callback(JSON.parse(message));
        } catch {
          callback(message);
        }
      }
    });
  }

  unsubscribe(channel) {
    this.subscriberClient.unsubscribe(channel);
  }
}

const redisService = new RedisService();
module.exports = { redisService };
