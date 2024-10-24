const { Decimal } = require("decimal.js");
const uuid = require("uuid");
const { redisService } = require("../services/redis.service");

function ensureDecimal(value) {
  return value instanceof Decimal ? value : new Decimal(value);
}

function scalePrice(price) {
  return parseInt(price) / 100;
}

function unscalePrice(price) {
  return parseInt(parseFloat(price) * 100);
}

function isValidPrice(price) {
  return price.gte(1) && price.lte(10);
}

async function apiTest(req, res) {
  try {
    res.status(200).json({ msg: "API is up and running" });
  } catch (error) {
    console.error("API test error:", error);
    res.status(500).json({ msg: "Internal server error" });
  }
}

async function resetData(req, res) {
  try {
    await redisService.hdel("users", "all");
    await redisService.hdel("orderbook", "all");
    await redisService.hdel("stockBalances", "all");
    await initialiseDummyData();
    res.status(200).json({ msg: "Data reset successfully" });
    redisService.publish("updates", { event: "dataReset" });
  } catch (error) {
    console.error("Reset data error:", error);
    res.status(500).json({ msg: "Failed to reset data" });
  }
}

async function createUser(req, res) {
  try {
    const userId = req.params.userId || uuid.v4();
    await redisService.hset("users", userId, {
      balance: 0,
      locked: 0,
    });
    res.status(201).json({ msg: `User ${userId} created`, userId });
    redisService.publish("updates", { event: "userCreated", userId });
  } catch (error) {
    console.error("Create user error:", error);
    res.status(500).json({ msg: "Failed to create user" });
  }
}

async function createSymbol(req, res) {
  const { symbolName } = req.params;
  try {
    if (!symbolName) {
      return res.status(400).json({ msg: "Symbol name is required" });
    }
    const orderbook = await redisService.hget("orderbook", symbolName);
    if (orderbook) {
      return res.status(409).json({ msg: "Symbol already exists" });
    }
    await redisService.hset("orderbook", symbolName, { yes: {}, no: {} });
    res.status(201).json({ msg: { yes: {}, no: {} } });
    redisService.publish("updates", { event: "symbolCreated", symbolName });
  } catch (error) {
    console.error("Create symbol error:", error);
    res.status(500).json({ msg: "Failed to create symbol" });
  }
}

async function getINRBalance(req, res) {
  const { userId } = req.params;
  try {
    if (userId) {
      const userBalance = await redisService.hget("users", userId);
      if (userBalance) {
        res.json({ msg: userBalance });
      } else {
        res.status(404).json({ msg: "User not found" });
      }
    } else {
      const users = await redisService.hgetall("users");
      res.json({ msg: users || {} });
    }
  } catch (error) {
    console.error("Get INR balance error:", error);
    res.status(500).json({ msg: "Failed to retrieve INR balance" });
  }
}

async function getStockBalance(req, res) {
  const { userId } = req.params;
  try {
    const stockBalances = await redisService.hgetall("stockBalances");
    if (userId) {
      res.json({ msg: stockBalances[userId] || {} });
    } else {
      res.json({ msg: stockBalances || {} });
    }
  } catch (error) {
    console.error("Get stock balance error:", error);
    res.status(500).json({ msg: "Failed to retrieve stock balance" });
  }
}

async function onrampINR(req, res) {
  const { userId, amount } = req.body;
  try {
    if (!userId || !amount || isNaN(amount) || parseInt(amount) <= 0) {
      return res.status(400).json({ msg: "Invalid input" });
    }

    const userBalance = await redisService.hget("users", userId);
    if (!userBalance) {
      return res.status(404).json({ msg: "User not found" });
    }

    userBalance.balance = parseInt(userBalance.balance) + parseInt(amount);
    await redisService.hset("users", userId, userBalance);

    res.json({ msg: `Onramped ${userId} with amount ${amount}` });
    redisService.publish("updates", {
      event: "balanceUpdated",
      userId,
      balance: userBalance.balance,
    });
  } catch (error) {
    console.error("Onramp INR error:", error);
    res.status(500).json({ msg: "Failed to onramp INR" });
  }
}

async function buyStock(req, res) {
  const { userId, stockSymbol, quantity, price, stockType } = req.body;
  try {
    await validateInput(userId, stockSymbol, quantity, price, stockType);
    await checkStockSymbolExists(stockSymbol);

    const decimalPrice = ensureDecimal(price);
    const scaledPrice = scalePrice(decimalPrice);
    const totalCost = ensureDecimal(quantity).times(decimalPrice);

    await checkSufficientBalance(userId, totalCost);

    const orderbook = await redisService.hget("orderbook", stockSymbol);
    if (!orderbook) {
      throw new Error("Orderbook not found");
    }

    const oppositeType = stockType === "yes" ? "no" : "yes";
    const sellOrders = orderbook[oppositeType];
    const sellPrices = Object.keys(sellOrders)
      .map(Number)
      .sort((a, b) => a - b);

    let remainingQuantity = quantity;
    let totalSpent = 0;

    for (const sellPrice of sellPrices) {
      if (sellPrice > scaledPrice) break;
      const availableQuantity = parseInt(sellOrders[sellPrice].total);
      const matchedQuantity = Math.min(remainingQuantity, availableQuantity);

      await executeTrade(
        stockSymbol,
        sellPrice,
        matchedQuantity,
        { [userId]: matchedQuantity },
        sellOrders[sellPrice].orders
      );

      remainingQuantity -= matchedQuantity;
      totalSpent += matchedQuantity * unscalePrice(sellPrice);

      if (remainingQuantity === 0) break;
    }
    if (remainingQuantity > 0) {
      await placePendingBuyOrder(
        stockSymbol,
        stockType,
        scaledPrice,
        remainingQuantity,
        userId,
        "reverted"
      );
    }

    await matchOrders(stockSymbol);

    res.json({ msg: "Buy order placed and matching attempted" });
    publishOrderUpdate(stockSymbol, stockType, userId, quantity, price);
  } catch (error) {
    console.error("Buy stock error:", error);
    res.status(400).json({ msg: error.message });
  }
}

async function placeSellOrder(req, res) {
  const { userId, stockSymbol, quantity, price, stockType } = req.body;
  try {
    await validateInput(userId, stockSymbol, quantity, price, stockType);

    const decimalPrice = ensureDecimal(price);
    const scaledPrice = scalePrice(decimalPrice);

    await checkSufficientStockBalance(userId, stockSymbol, stockType, quantity);

    await placePendingSellOrder(
      stockSymbol,
      stockType,
      scaledPrice,
      quantity,
      userId,
      "sell"
    );

    await matchOrders(stockSymbol);

    res.json({ msg: "Sell order placed and matching attempted" });
    publishOrderUpdate(stockSymbol, stockType, userId, quantity, price);
  } catch (error) {
    console.error("Place sell order error:", error);
    res.status(400).json({ msg: error.message });
  }
}

async function mintTokens(req, res) {
  const { userId, stockSymbol, quantity } = req.body;
  const price = 100;
  try {
    await validateMintTokensInput(userId, stockSymbol, quantity);

    const totalCost = quantity * price;
    await checkSufficientBalance(userId, totalCost);

    await updateBalancesAfterMinting(userId, stockSymbol, quantity, totalCost);

    res.json({
      msg: `Minted ${quantity} 'yes' and 'no' tokens for user ${userId}`,
    });
    publishMintUpdate(userId, stockSymbol, quantity, price);
  } catch (error) {
    console.error("Mint tokens error:", error);
    res.status(400).json({ msg: error.message });
  }
}

async function viewOrderbook(req, res) {
  try {
    const orderbook = await redisService.hgetall("orderbook");
    res.json({ msg: orderbook || {} });
  } catch (error) {
    console.error("View orderbook error:", error);
    res.status(500).json({ msg: "Failed to retrieve orderbook" });
  }
}

async function viewIndividualOrderbook(req, res) {
  const { stockSymbol } = req.params;
  try {
    const orderbook = await redisService.hget("orderbook", stockSymbol);
    if (!orderbook) {
      return res.status(404).json({ msg: "Orderbook not found" });
    }
    res.json({ msg: orderbook });
  } catch (error) {
    console.error("View individual orderbook error:", error);
    res.status(500).json({ msg: "Failed to retrieve individual orderbook" });
  }
}

async function cancelOrder(req, res) {
  const { userId, stockSymbol, quantity, price, stockType } = req.body;
  try {
    await validateInput(userId, stockSymbol, quantity, price, stockType);
    const scaledPrice = scalePrice(price);

    await cancelExistingOrder(
      stockSymbol,
      stockType,
      scaledPrice,
      quantity,
      userId
    );

    res.json({ msg: "Order canceled successfully" });
    publishCancelUpdate(userId, stockSymbol, quantity, price, stockType);
  } catch (error) {
    console.error("Cancel order error:", error);
    res.status(400).json({ msg: error.message });
  }
}

async function validateInput(userId, stockSymbol, quantity, price, stockType) {
  if (!userId || !stockSymbol || !quantity || !price || !stockType) {
    throw new Error("Missing required parameters");
  }

  const decimalPrice = ensureDecimal(price);

  if (quantity <= 0 || !Number.isInteger(quantity)) {
    throw new Error("Quantity must be a positive integer");
  }

  if (!isValidPrice(decimalPrice)) {
    throw new Error("Price must be between 1 and 10");
  }

  if (stockType !== "yes" && stockType !== "no") {
    throw new Error("Invalid stock type");
  }
}

async function checkStockSymbolExists(stockSymbol) {
  const orderbook = await redisService.hget("orderbook", stockSymbol);
  if (!orderbook) {
    throw new Error("Stock symbol not found");
  }
}

async function checkSufficientBalance(userId, amount) {
  const userBalance = await redisService.hget("users", userId);
  if (!userBalance) {
    throw new Error("User not found");
  }
  if (parseInt(userBalance.balance) < amount) {
    throw new Error("Insufficient balance");
  }
}

async function updateBalancesAfterMinting(
  userId,
  stockSymbol,
  quantity,
  totalCost
) {
  const userBalance = await redisService.hget("users", userId);
  userBalance.balance = parseInt(userBalance.balance) - totalCost;
  await redisService.hset("users", userId, userBalance);

  let stockBalances = (await redisService.hget("stockBalances", userId)) || {};
  if (!stockBalances[stockSymbol]) {
    stockBalances[stockSymbol] = {
      yes: { quantity: 0, locked: 0 },
      no: { quantity: 0, locked: 0 },
    };
  }

  stockBalances[stockSymbol].yes.quantity += quantity;
  stockBalances[stockSymbol].no.quantity += quantity;
  await redisService.hset("stockBalances", userId, stockBalances);
}

async function checkSufficientStockBalance(
  userId,
  stockSymbol,
  stockType,
  quantity
) {
  const stockBalances = await redisService.hget("stockBalances", userId);
  if (
    !stockBalances ||
    !stockBalances[stockSymbol] ||
    !stockBalances[stockSymbol][stockType] ||
    stockBalances[stockSymbol][stockType].quantity < quantity
  ) {
    throw new Error("Insufficient stock balance");
  }
}

async function executeTrade(stockSymbol, price, quantity, yesOrders, noOrders) {
  const decimalPrice = ensureDecimal(price);
  const unscaledPrice = unscalePrice(decimalPrice);
  for (const [yesUserId, yesQuantity] of Object.entries(yesOrders)) {
    for (const [noUserId, noQuantity] of Object.entries(noOrders)) {
      const tradeQuantity = Math.min(yesQuantity, noQuantity, quantity);
      await updateBalancesAfterTrade(
        yesUserId,
        noUserId,
        stockSymbol,
        unscaledPrice,
        tradeQuantity,
        tradeCost
      );
      quantity -= tradeQuantity;
      if (quantity === 0) return;
    }
  }
}

async function updateBalancesAfterTrade(
  yesUserId,
  noUserId,
  stockSymbol,
  price,
  quantity
) {
  const [yesUser, noUser] = await Promise.all([
    redisService.hget("users", yesUserId),
    redisService.hget("users", noUserId),
  ]);

  const [yesStocks, noStocks] = await Promise.all([
    redisService.hget("stockBalances", yesUserId),
    redisService.hget("stockBalances", noUserId),
  ]);

  yesUser.locked -= price * quantity;
  noUser.balance += price * quantity;

  yesStocks[stockSymbol].yes.quantity += quantity;
  yesStocks[stockSymbol].yes.locked -= quantity;
  noStocks[stockSymbol].no.quantity -= quantity;
  noStocks[stockSymbol].no.locked -= quantity;

  await Promise.all([
    redisService.hset("users", yesUserId, yesUser),
    redisService.hset("users", noUserId, noUser),
    redisService.hset("stockBalances", yesUserId, yesStocks),
    redisService.hset("stockBalances", noUserId, noStocks),
  ]);
}

async function placePendingBuyOrder(
  stockSymbol,
  stockType,
  price,
  quantity,
  userId,
  orderType
) {
  const orderbook = await redisService.hget("orderbook", stockSymbol);
  if (!orderbook[stockType][price]) {
    orderbook[stockType][price] = { total: 0, orders: {} };
  }

  orderbook[stockType][price].total += quantity;
  orderbook[stockType][price].orders[userId] = {
    type: orderType,
    quantity: quantity,
  };

  await redisService.hset("orderbook", stockSymbol, orderbook);

  const userBalance = await redisService.hget("users", userId);
  const totalCost = quantity * unscalePrice(price);
  userBalance.balance -= totalCost;
  userBalance.locked += totalCost;
  await redisService.hset("users", userId, userBalance);
}

async function placePendingSellOrder(
  stockSymbol,
  stockType,
  price,
  quantity,
  userId,
  orderType
) {
  const orderbook = await redisService.hget("orderbook", stockSymbol);
  if (!orderbook[stockType][price]) {
    orderbook[stockType][price] = { total: 0, orders: {} };
  }

  orderbook[stockType][price].total += quantity;
  orderbook[stockType][price].orders[userId] = {
    type: orderType,
    quantity: quantity,
  };

  await redisService.hset("orderbook", stockSymbol, orderbook);

  const stockBalances = await redisService.hget("stockBalances", userId);
  stockBalances[stockSymbol][stockType].quantity -= quantity;
  stockBalances[stockSymbol][stockType].locked += quantity;
  await redisService.hset("stockBalances", userId, stockBalances);
}

async function matchOrders(stockSymbol) {
  const orderbook = await redisService.hget("orderbook", stockSymbol);
  if (!orderbook) return;

  const yesOrders = orderbook.yes;
  const noOrders = orderbook.no;

  const yesPrices = Object.keys(yesOrders)
    .map(Number)
    .sort((a, b) => b - a);
  const noPrices = Object.keys(noOrders)
    .map(Number)
    .sort((a, b) => a - b);

  while (yesPrices.length > 0 && noPrices.length > 0) {
    const yesPrice = yesPrices[0];
    const noPrice = noPrices[0];

    if (yesPrice + noPrice === 10.5) {
      const yesOrder = yesOrders[yesPrice];
      const noOrder = noOrders[noPrice];

      const matchQuantity = Math.min(
        parseInt(yesOrder.total),
        parseInt(noOrder.total)
      );

      await executeTrade(
        stockSymbol,
        yesPrice,
        matchQuantity,
        yesOrder.orders,
        noOrder.orders
      );

      yesOrder.total -= matchQuantity;
      noOrder.total -= matchQuantity;

      if (yesOrder.total === 0) {
        delete yesOrders[yesPrice];
        yesPrices.shift();
      }
      if (noOrder.total === 0) {
        delete noOrders[noPrice];
        noPrices.shift();
      }
    } else if (yesPrice + noPrice > 10.5) {
      noPrices.shift();
    } else {
      yesPrices.shift();
    }
  }

  await redisService.hset("orderbook", stockSymbol, orderbook);
}

async function cancelExistingOrder(
  stockSymbol,
  stockType,
  price,
  quantity,
  userId
) {
  const orderbook = await redisService.hget("orderbook", stockSymbol);
  if (!orderbook[stockType][price]?.orders[userId]) {
    throw new Error("Order not found");
  }

  const existingOrder = orderbook[stockType][price].orders[userId];
  const cancelQuantity = Math.min(quantity, existingOrder.quantity);

  orderbook[stockType][price].total -= cancelQuantity;
  existingOrder.quantity -= cancelQuantity;

  if (existingOrder.quantity === 0) {
    delete orderbook[stockType][price].orders[userId];
  }
  if (orderbook[stockType][price].total === 0) {
    delete orderbook[stockType][price];
  }

  await redisService.hset("orderbook", stockSymbol, orderbook);
  await updateBalancesAfterCancel(
    userId,
    stockSymbol,
    stockType,
    price,
    cancelQuantity
  );
}

async function updateBalancesAfterCancel(
  userId,
  stockSymbol,
  stockType,
  price,
  quantity
) {
  if (stockType === "yes") {
    const userBalance = await redisService.hget("users", userId);
    const unscaledPrice = unscalePrice(price);
    userBalance.locked -= quantity * unscaledPrice;
    userBalance.balance += quantity * unscaledPrice;
    await redisService.hset("users", userId, userBalance);
  } else {
    const stockBalances = await redisService.hget("stockBalances", userId);
    stockBalances[stockSymbol][stockType].locked -= quantity;
    stockBalances[stockSymbol][stockType].quantity += quantity;
    await redisService.hset("stockBalances", userId, stockBalances);
  }
}

async function validateMintTokensInput(userId, stockSymbol, quantity) {
  if (!userId || !stockSymbol || !quantity) {
    throw new Error("Missing required parameters for minting tokens");
  }

  if (quantity <= 0 || !Number.isInteger(quantity)) {
    throw new Error("Quantity must be a positive integer");
  }
}

function publishOrderUpdate(stockSymbol, stockType, userId, quantity, price) {
  redisService.publish("updates", {
    stockSymbol,
    [stockType]: {
      [scalePrice(price)]: {
        total: quantity,
        orders: {
          [userId]: {
            type: stockType === "yes" ? "reverted" : "sell",
            quantity: quantity,
          },
        },
      },
    },
  });
}

function publishMintUpdate(userId, stockSymbol, quantity, price) {
  redisService.publish("updates", {
    event: "tokensMinted",
    userId,
    stockSymbol,
    quantity,
    price: scalePrice(price),
  });
}

function publishCancelUpdate(userId, stockSymbol, quantity, price, stockType) {
  redisService.publish("updates", {
    event: "event_orderbook_update",
    message: JSON.stringify({
      stockSymbol,
      [stockType]: {
        [scalePrice(price)]: {
          total: 0,
          orders: {},
        },
      },
    }),
  });
}

async function initialiseDummyData() {
  console.log("Initializing dummy data...");

  try {
    const users = {
      user1: { balance: 10000, locked: 0 },
      user2: { balance: 20000, locked: 5000 },
      user3: { balance: 15000, locked: 2000 },
    };

    for (const [userId, balance] of Object.entries(users)) {
      await redisService.hset("users", userId, balance);
    }

    const orderbook = {
      BTC_USDT_10_Oct_2024_9_30: {
        yes: {
          9.5: {
            total: 1200,
            orders: {
              user1: { type: "reverted", quantity: 200 },
              user2: { type: "reverted", quantity: 1000 },
            },
          },
          8.5: {
            total: 1200,
            orders: {
              user1: { type: "reverted", quantity: 300 },
              user2: { type: "reverted", quantity: 300 },
              user3: { type: "reverted", quantity: 600 },
            },
          },
        },
        no: {
          10.5: {
            total: 800,
            orders: {
              user2: { type: "sell", quantity: 500 },
              user3: { type: "sell", quantity: 300 },
            },
          },
        },
      },
    };

    await redisService.hset(
      "orderbook",
      "BTC_USDT_10_Oct_2024_9_30",
      orderbook.BTC_USDT_10_Oct_2024_9_30
    );

    const stockBalances = {
      user1: {
        BTC_USDT_10_Oct_2024_9_30: {
          yes: { quantity: 100, locked: 0 },
          no: { quantity: 50, locked: 0 },
        },
      },
      user2: {
        BTC_USDT_10_Oct_2024_9_30: {
          yes: { quantity: 200, locked: 100 },
          no: { quantity: 150, locked: 50 },
        },
      },
      user3: {
        BTC_USDT_10_Oct_2024_9_30: {
          yes: { quantity: 150, locked: 50 },
          no: { quantity: 100, locked: 0 },
        },
      },
    };

    for (const [userId, balances] of Object.entries(stockBalances)) {
      await redisService.hset("stockBalances", userId, balances);
    }

    console.log("Dummy data initialized successfully");
  } catch (error) {
    console.error("Error initializing dummy data:", error);
    throw error;
  }
}

module.exports = {
  apiTest,
  resetData,
  createUser,
  createSymbol,
  getINRBalance,
  getStockBalance,
  onrampINR,
  buyStock,
  placeSellOrder,
  viewOrderbook,
  cancelOrder,
  mintTokens,
  viewIndividualOrderbook,
  initialiseDummyData,
};
