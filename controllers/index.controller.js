const { Decimal } = require("decimal.js");
const uuid = require("uuid");
const { redisService } = require("../services/redis.service");

function ensureDecimal(value) {
  return value instanceof Decimal ? value : new Decimal(value);
}

function isValidPrice(price) {
  return price.gte(1) && price.lte(10);
}

async function apiTest(req, res) {
  try {
    res.status(200).json({ message: "API is up and running" });
  } catch (error) {
    console.error("API test error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
}

async function resetData(req, res) {
  try {
    await redisService.hdel("users", "all");
    await redisService.hdel("orderbook", "all");
    await redisService.hdel("stockBalances", "all");
    await initialiseDummyData();
    res.status(200).json({ message: "Data reset successfully" });
    redisService.publish("updates", { event: "dataReset" });
  } catch (error) {
    console.error("Reset data error:", error);
    res.status(500).json({ message: "Failed to reset data" });
  }
}

async function createUser(req, res) {
  try {
    const userId = uuid.v4();
    await redisService.hset("users", userId, {
      balance: "0",
      locked: "0",
    });
    res.status(201).json({ message: `User ${userId} created`, userId });
    redisService.publish("updates", { event: "userCreated", userId });
  } catch (error) {
    console.error("Create user error:", error);
    res.status(500).json({ message: "Failed to create user" });
  }
}

async function createSymbol(req, res) {
  const { symbolName } = req.params;
  try {
    if (!symbolName) {
      return res.status(400).json({ message: "Symbol name is required" });
    }
    const orderbook = await redisService.hget("orderbook", symbolName);
    if (orderbook) {
      return res.status(409).json({ message: "Symbol already exists" });
    }
    await redisService.hset("orderbook", symbolName, { yes: {}, no: {} });
    res.status(201).json({ message: `Symbol ${symbolName} created` });
    redisService.publish("updates", { event: "symbolCreated", symbolName });
  } catch (error) {
    console.error("Create symbol error:", error);
    res.status(500).json({ message: "Failed to create symbol" });
  }
}

async function getINRBalance(req, res) {
  const { userId } = req.params;
  try {
    if (userId) {
      const userBalance = await redisService.hget("users", userId);
      if (userBalance) {
        res.json({ [userId]: userBalance });
      } else {
        res.status(404).json({ message: "User not found" });
      }
    } else {
      const users = await redisService.hgetall("users");
      res.json(users || {});
    }
  } catch (error) {
    console.error("Get INR balance error:", error);
    res.status(500).json({ message: "Failed to retrieve INR balance" });
  }
}

async function getStockBalance(req, res) {
  const { userId } = req.params;
  try {
    const stockBalances = await redisService.hgetall("stockBalances");
    if (userId) {
      res.json({ [userId]: stockBalances[userId] || {} });
    } else {
      res.json(stockBalances || {});
    }
  } catch (error) {
    console.error("Get stock balance error:", error);
    res.status(500).json({ message: "Failed to retrieve stock balance" });
  }
}

async function onrampINR(req, res) {
  const { userId, amount } = req.body;
  try {
    if (!userId || !amount || isNaN(amount) || ensureDecimal(amount).lte(0)) {
      return res.status(400).json({ message: "Invalid input" });
    }

    const userBalance = await redisService.hget("users", userId);
    if (!userBalance) {
      return res.status(404).json({ message: "User not found" });
    }

    userBalance.balance = ensureDecimal(userBalance.balance)
      .plus(ensureDecimal(amount))
      .toString();
    await redisService.hset("users", userId, userBalance);

    res.json({ message: `Onramped ${userId} with amount ${amount}` });
    redisService.publish("updates", {
      event: "balanceUpdated",
      userId,
      balance: userBalance.balance,
    });
  } catch (error) {
    console.error("Onramp INR error:", error);
    res.status(500).json({ message: "Failed to onramp INR" });
  }
}

async function buyStock(req, res) {
  const { userId, stockSymbol, quantity, price, stockType } = req.body;
  try {
    await validateInput(userId, stockSymbol, quantity, price, stockType);
    await checkStockSymbolExists(stockSymbol);

    const decimalPrice = ensureDecimal(price);
    const totalCost = quantity.times(decimalPrice);

    await checkSufficientBalance(userId, totalCost);

    const orderbook = await redisService.hget("orderbook", stockSymbol);
    if (!orderbook) {
      throw new Error("Orderbook not found");
    }

    const oppositeType = stockType === "yes" ? "no" : "yes";
    const sellOrders = orderbook[oppositeType];
    const sellPrices = Object.keys(sellOrders)
      .map((price) => ensureDecimal(price))
      .sort((a, b) => a.minus(b).toNumber());

    let remainingQuantity = quantity;
    let totalSpent = ensureDecimal(0);

    for (const sellPrice of sellPrices) {
      if (sellPrice.gt(decimalPrice)) break;
      const availableQuantity = parseInt(
        sellOrders[sellPrice.toString()].total
      );
      const matchedQuantity = Math.min(remainingQuantity, availableQuantity);

      await executeTrade(
        stockSymbol,
        sellPrice,
        matchedQuantity,
        { [userId]: matchedQuantity },
        sellOrders[sellPrice.toString()].orders
      );

      remainingQuantity -= matchedQuantity;
      totalSpent = totalSpent.plus(
        ensureDecimal(matchedQuantity).times(sellPrice)
      );

      if (remainingQuantity === 0) break;
    }

    if (remainingQuantity > 0) {
      await placePendingBuyOrder(
        stockSymbol,
        stockType,
        decimalPrice,
        remainingQuantity,
        userId
      );
    }

    await matchOrders(stockSymbol);

    res.json({ message: "Buy order placed and matching attempted" });
    redisService.publish("updates", {
      event: "orderPlaced",
      type: "buy",
      userId,
      stockSymbol,
      quantity: quantity.toString(),
      price: decimalPrice.toString(),
      stockType,
    });
  } catch (error) {
    console.error("Buy stock error:", error);
    res.status(400).json({ message: error.message });
  }
}

async function placeSellOrder(req, res) {
  const { userId, stockSymbol, quantity, price, stockType } = req.body;
  try {
    await validateInput(userId, stockSymbol, quantity, price, stockType);

    const decimalQuantity = ensureDecimal(quantity);
    const decimalPrice = ensureDecimal(price);

    await checkSufficientStockBalance(
      userId,
      stockSymbol,
      stockType,
      decimalQuantity
    );

    await placePendingSellOrder(
      stockSymbol,
      stockType,
      decimalPrice,
      decimalQuantity,
      userId
    );

    await matchOrders(stockSymbol);

    res.json({ message: "Sell order placed and matching attempted" });
    redisService.publish("updates", {
      event: "orderPlaced",
      type: "sell",
      userId,
      stockSymbol,
      quantity: decimalQuantity.toString(),
      price: decimalPrice.toString(),
      stockType,
    });
  } catch (error) {
    console.error("Place sell order error:", error);
    res.status(400).json({ message: error.message });
  }
}

async function viewOrderbook(req, res) {
  try {
    const orderbook = await redisService.hgetall("orderbook");
    res.json(orderbook || {});
  } catch (error) {
    console.error("View orderbook error:", error);
    res.status(500).json({ message: "Failed to retrieve orderbook" });
  }
}

async function cancelOrder(req, res) {
  const { userId, stockSymbol, quantity, price, stockType } = req.body;
  try {
    await validateInput(userId, stockSymbol, quantity, price, stockType);

    const decimalQuantity = ensureDecimal(quantity);
    const decimalPrice = ensureDecimal(price);

    const orderbook = await redisService.hget("orderbook", stockSymbol);
    if (
      !orderbook ||
      !orderbook[stockType][decimalPrice.toString()] ||
      !orderbook[stockType][decimalPrice.toString()].orders[userId]
    ) {
      throw new Error("Order not found");
    }

    const cancelQuantity = Decimal.min(
      decimalQuantity,
      ensureDecimal(
        orderbook[stockType][decimalPrice.toString()].orders[userId]
      )
    );

    await updateOrderbookAfterCancel(
      stockSymbol,
      stockType,
      decimalPrice,
      cancelQuantity,
      userId
    );
    await updateBalancesAfterCancel(
      userId,
      stockSymbol,
      stockType,
      decimalPrice,
      cancelQuantity
    );

    res.json({ message: `${stockType} order canceled` });
    redisService.publish("updates", {
      event: "orderCanceled",
      userId,
      stockSymbol,
      quantity: cancelQuantity.toString(),
      price: decimalPrice.toString(),
      stockType,
    });
  } catch (error) {
    console.error("Cancel order error:", error);
    res.status(400).json({ message: error.message });
  }
}

async function mintTokens(req, res) {
  const { userId, stockSymbol, quantity, price } = req.body;
  try {
    await validateMintTokensInput(userId, stockSymbol, quantity, price);

    const decimalQuantity = ensureDecimal(quantity);
    const decimalPrice = ensureDecimal(price);
    const totalCost = decimalQuantity.times(decimalPrice);

    await checkSufficientBalance(userId, totalCost);

    await updateBalancesAfterMinting(
      userId,
      stockSymbol,
      decimalQuantity,
      totalCost
    );

    res.json({
      message: `Minted ${quantity} 'yes' and 'no' tokens for user ${userId}`,
    });
    redisService.publish("updates", {
      event: "tokensMinted",
      userId,
      stockSymbol,
      quantity: decimalQuantity.toString(),
      price: decimalPrice.toString(),
    });
  } catch (error) {
    console.error("Mint tokens error:", error);
    res.status(400).json({ message: error.message });
  }
}

async function viewIndividualOrderbook(req, res) {
  const { stockSymbol } = req.params;
  try {
    const individualOrderbook = await redisService.hget(
      "orderbook",
      stockSymbol
    );

    if (!individualOrderbook) {
      return res
        .status(404)
        .json({ error: "Orderbook with provided stock symbol not found" });
    }

    return res.json(individualOrderbook);
  } catch (error) {
    console.error("View individual orderbook error:", error);
    res
      .status(500)
      .json({ message: "Failed to retrieve individual orderbook" });
  }
}

async function initialiseDummyData() {
  console.log("Initializing dummy data...");

  try {
    const users = ["user1", "user2", "user3"];
    for (const user of users) {
      await redisService.hset("users", user, {
        balance:
          user === "user1" ? "10000" : user === "user2" ? "20000" : "15000",
        locked: user === "user2" ? "5000" : user === "user3" ? "2000" : "0",
      });
    }

    const orderbook = {
      BTC_USDT_10_Oct_2024_9_30: {
        yes: {
          9.5: {
            total: "1200",
            orders: {
              user1: "200",
              user2: "1000",
            },
          },
          8.5: {
            total: "1200",
            orders: {
              user1: "300",
              user2: "300",
              user3: "600",
            },
          },
        },
        no: {
          10.5: {
            total: "800",
            orders: {
              user2: "500",
              user3: "300",
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
          yes: { quantity: "100", locked: "0" },
          no: { quantity: "50", locked: "0" },
        },
      },
      user2: {
        BTC_USDT_10_Oct_2024_9_30: {
          yes: { quantity: "200", locked: "100" },
          no: { quantity: "150", locked: "50" },
        },
      },
      user3: {
        BTC_USDT_10_Oct_2024_9_30: {
          yes: { quantity: "150", locked: "50" },
          no: { quantity: "100", locked: "0" },
        },
      },
    };
    await redisService.hset("stockBalances", "user1", stockBalances.user1);
    await redisService.hset("stockBalances", "user2", stockBalances.user2);
    await redisService.hset("stockBalances", "user3", stockBalances.user3);

    console.log("Dummy data initialised successfully");
  } catch (error) {
    console.error("Error initializing dummy data:", error);
    throw error;
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
  if (new Decimal(userBalance.balance).lt(amount)) {
    throw new Error("Insufficient INR balance");
  }
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
    parseInt(stockBalances[stockSymbol][stockType].quantity) < quantity
  ) {
    throw new Error("Insufficient stock balance");
  }
}

async function updateOrderbook(stockSymbol, side, price, quantity, userId) {
  const orderbook = (await redisService.hget("orderbook", stockSymbol)) || {
    yes: {},
    no: {},
  };
  const priceString = price.toString();
  if (!orderbook[side][priceString]) {
    orderbook[side][priceString] = { total: 0, orders: {} };
  }
  if (!orderbook[side][priceString].orders[userId]) {
    orderbook[side][priceString].orders[userId] = 0;
  }
  orderbook[side][priceString].total += quantity;
  orderbook[side][priceString].orders[userId] += quantity;
  await redisService.hset("orderbook", stockSymbol, orderbook);
}

async function executeTrade(stockSymbol, price, quantity, yesOrders, noOrders) {
  for (const [yesUserId, yesQuantity] of Object.entries(yesOrders)) {
    for (const [noUserId, noQuantity] of Object.entries(noOrders)) {
      const tradeQuantity = Math.min(
        parseInt(yesQuantity),
        parseInt(noQuantity),
        quantity
      );

      await updateBalancesAfterTrade(
        yesUserId,
        noUserId,
        stockSymbol,
        price,
        tradeQuantity
      );

      yesOrders[yesUserId] = ensureDecimal(yesOrders[yesUserId])
        .minus(tradeQuantity)
        .toString();
      noOrders[noUserId] = ensureDecimal(noOrders[noUserId])
        .minus(tradeQuantity)
        .toString();
      quantity = quantity.minus(tradeQuantity);

      if (ensureDecimal(yesOrders[yesUserId]).eq(0))
        delete yesOrders[yesUserId];
      if (ensureDecimal(noOrders[noUserId]).eq(0)) delete noOrders[noUserId];

      if (quantity.eq(0)) return;
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
  const yesUserBalance = await redisService.hget("users", yesUserId);
  const noUserBalance = await redisService.hget("users", noUserId);
  const yesStockBalances = await redisService.hget("stockBalances", yesUserId);
  const noStockBalances = await redisService.hget("stockBalances", noUserId);

  // Update YES user
  yesUserBalance.locked = ensureDecimal(yesUserBalance.locked)
    .minus(ensureDecimal(quantity).times(price))
    .toString();
  yesStockBalances[stockSymbol].yes.quantity = (
    parseInt(yesStockBalances[stockSymbol].yes.quantity) + quantity
  ).toString();
  yesStockBalances[stockSymbol].yes.locked = (
    parseInt(yesStockBalances[stockSymbol].yes.locked) - quantity
  ).toString();

  // Update NO user
  noUserBalance.balance = ensureDecimal(noUserBalance.balance)
    .plus(ensureDecimal(quantity).times(price))
    .toString();
  noStockBalances[stockSymbol].no.quantity = (
    parseInt(noStockBalances[stockSymbol].no.quantity) - quantity
  ).toString();
  noStockBalances[stockSymbol].no.locked = (
    parseInt(noStockBalances[stockSymbol].no.locked) - quantity
  ).toString();

  await redisService.hset("users", yesUserId, yesUserBalance);
  await redisService.hset("users", noUserId, noUserBalance);
  await redisService.hset("stockBalances", yesUserId, yesStockBalances);
  await redisService.hset("stockBalances", noUserId, noStockBalances);
}

function ensureStockBalanceExists(stockBalances, userId, stockSymbol) {
  if (!stockBalances[userId]) {
    stockBalances[userId] = {};
  }
  if (!stockBalances[userId][stockSymbol]) {
    stockBalances[userId][stockSymbol] = {
      yes: { quantity: "0", locked: "0" },
      no: { quantity: "0", locked: "0" },
    };
  }
}

async function placePendingBuyOrder(
  stockSymbol,
  stockType,
  decimalPrice,
  quantity,
  userId
) {
  await updateOrderbook(stockSymbol, stockType, decimalPrice, quantity, userId);
  const userBalance = await redisService.hget("users", userId);
  const totalCost = ensureDecimal(quantity).times(decimalPrice);
  userBalance.balance = ensureDecimal(userBalance.balance)
    .minus(totalCost)
    .toString();
  userBalance.locked = ensureDecimal(userBalance.locked)
    .plus(totalCost)
    .toString();
  await redisService.hset("users", userId, userBalance);
}

async function placePendingSellOrder(
  stockSymbol,
  stockType,
  decimalPrice,
  quantity,
  userId
) {
  await updateOrderbook(stockSymbol, stockType, decimalPrice, quantity, userId);
  const stockBalances = await redisService.hget("stockBalances", userId);
  stockBalances[stockSymbol][stockType].quantity = (
    parseInt(stockBalances[stockSymbol][stockType].quantity) - quantity
  ).toString();
  stockBalances[stockSymbol][stockType].locked = (
    parseInt(stockBalances[stockSymbol][stockType].locked) + quantity
  ).toString();
  await redisService.hset("stockBalances", userId, stockBalances);
}

async function matchOrders(stockSymbol) {
  const orderbook = await redisService.hget("orderbook", stockSymbol);
  if (!orderbook) return;

  const yesOrders = orderbook.yes;
  const noOrders = orderbook.no;

  const yesPrices = Object.keys(yesOrders)
    .map((price) => ensureDecimal(price))
    .filter(isValidPrice)
    .sort((a, b) => b.minus(a).toNumber());
  const noPrices = Object.keys(noOrders)
    .map((price) => ensureDecimal(price))
    .filter(isValidPrice)
    .sort((a, b) => a.minus(b).toNumber());

  while (yesPrices.length > 0 && noPrices.length > 0) {
    const yesPrice = yesPrices[0];
    const noPrice = noPrices[0];

    if (yesPrice.plus(noPrice).eq(ensureDecimal("10.5"))) {
      const yesOrder = yesOrders[yesPrice.toString()];
      const noOrder = noOrders[noPrice.toString()];

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

      yesOrder.total = (parseInt(yesOrder.total) - matchQuantity).toString();
      noOrder.total = (parseInt(noOrder.total) - matchQuantity).toString();

      if (parseInt(yesOrder.total) === 0) {
        delete yesOrders[yesPrice.toString()];
        yesPrices.shift();
      }
      if (parseInt(noOrder.total) === 0) {
        delete noOrders[noPrice.toString()];
        noPrices.shift();
      }
    } else if (yesPrice.plus(noPrice).gt(ensureDecimal("10.5"))) {
      noPrices.shift();
    } else {
      yesPrices.shift();
    }
  }

  await redisService.hset("orderbook", stockSymbol, orderbook);
}

async function updateOrderbookAfterCancel(
  stockSymbol,
  stockType,
  price,
  quantity,
  userId
) {
  const orderbook = await redisService.hget("orderbook", stockSymbol);
  const priceString = price.toString();
  orderbook[stockType][priceString].total = ensureDecimal(
    orderbook[stockType][priceString].total
  )
    .minus(quantity)
    .toString();
  orderbook[stockType][priceString].orders[userId] = ensureDecimal(
    orderbook[stockType][priceString].orders[userId]
  )
    .minus(quantity)
    .toString();

  if (ensureDecimal(orderbook[stockType][priceString].orders[userId]).eq(0)) {
    delete orderbook[stockType][priceString].orders[userId];
  }
  if (ensureDecimal(orderbook[stockType][priceString].total).eq(0)) {
    delete orderbook[stockType][priceString];
  }
  await redisService.hset("orderbook", stockSymbol, orderbook);
}

async function updateBalancesAfterCancel(
  userId,
  stockSymbol,
  stockType,
  price,
  quantity
) {
  const userBalance = await redisService.hget("users", userId);
  const stockBalances = await redisService.hget("stockBalances", userId);

  if (stockType === "yes") {
    userBalance.locked = ensureDecimal(userBalance.locked)
      .minus(quantity.times(price))
      .toString();
    userBalance.balance = ensureDecimal(userBalance.balance)
      .plus(quantity.times(price))
      .toString();
  } else {
    stockBalances[stockSymbol][stockType].locked = ensureDecimal(
      stockBalances[stockSymbol][stockType].locked
    )
      .minus(quantity)
      .toString();
    stockBalances[stockSymbol][stockType].quantity = ensureDecimal(
      stockBalances[stockSymbol][stockType].quantity
    )
      .plus(quantity)
      .toString();
  }

  await redisService.hset("users", userId, userBalance);
  await redisService.hset("stockBalances", userId, stockBalances);
}

async function validateMintTokensInput(userId, stockSymbol, quantity, price) {
  if (!userId || !stockSymbol || !quantity || !price) {
    throw new Error("Missing required parameters for minting tokens");
  }

  const decimalPrice = ensureDecimal(price);

  if (quantity <= 0 || !Number.isInteger(quantity)) {
    throw new Error("Quantity must be a positive integer");
  }

  if (!isValidPrice(decimalPrice)) {
    throw new Error("Price must be between 1 and 10");
  }
}

async function updateBalancesAfterMinting(
  userId,
  stockSymbol,
  quantity,
  totalCost
) {
  const userBalance = await redisService.hget("users", userId);
  userBalance.balance = ensureDecimal(userBalance.balance)
    .minus(totalCost)
    .toString();
  await redisService.hset("users", userId, userBalance);

  let stockBalances = (await redisService.hget("stockBalances", userId)) || {};
  ensureStockBalanceExists(stockBalances, userId, stockSymbol);

  stockBalances[stockSymbol].yes.quantity = (
    parseInt(stockBalances[stockSymbol].yes.quantity) + quantity
  ).toString();
  stockBalances[stockSymbol].no.quantity = (
    parseInt(stockBalances[stockSymbol].no.quantity) + quantity
  ).toString();

  await redisService.hset("stockBalances", userId, stockBalances);
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
