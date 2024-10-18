const Decimal = require("decimal.js");

let INR_BALANCES = {};
let ORDERBOOK = {};
let STOCK_BALANCES = {};

function isValidPrice(price) {
  const decimalPrice = new Decimal(price);
  return decimalPrice.gte(1) && decimalPrice.lte(10);
}

function initialiseUserBalances(userId) {
  if (!INR_BALANCES[userId]) {
    INR_BALANCES[userId] = { balance: new Decimal(0), locked: new Decimal(0) };
  }
  if (!STOCK_BALANCES[userId]) {
    STOCK_BALANCES[userId] = {};
  }
}

function validateInput(userId, stockSymbol, quantity, price, stockType) {
  if (!userId || !stockSymbol || !quantity || !price || !stockType || new Decimal(quantity).lte(0) || !isValidPrice(price)) {
    throw new Error("Invalid input / Price must be between 1 and 10");
  }
}

function checkStockSymbolExists(stockSymbol) {
  if (!ORDERBOOK[stockSymbol]) {
    throw new Error("Stock symbol not found");
  }
}

function checkSufficientBalance(userId, amount) {
  if (INR_BALANCES[userId].balance.lt(amount)) {
    throw new Error("Insufficient INR balance");
  }
}

function checkSufficientStockBalance(userId, stockSymbol, stockType, quantity) {
  if (!STOCK_BALANCES[userId][stockSymbol] || STOCK_BALANCES[userId][stockSymbol][stockType].quantity.lt(quantity)) {
    throw new Error("Insufficient stock balance");
  }
}

function updateOrderbook(stockSymbol, side, price, quantity, userId) {
  if (!ORDERBOOK[stockSymbol]) {
    ORDERBOOK[stockSymbol] = { yes: {}, no: {} };
  }
  const priceString = price.toString();
  if (!ORDERBOOK[stockSymbol][side][priceString]) {
    ORDERBOOK[stockSymbol][side][priceString] = { total: new Decimal(0), orders: {} };
  }
  if (!ORDERBOOK[stockSymbol][side][priceString].orders[userId]) {
    ORDERBOOK[stockSymbol][side][priceString].orders[userId] = new Decimal(0);
  }
  ORDERBOOK[stockSymbol][side][priceString].total = ORDERBOOK[stockSymbol][side][priceString].total.plus(quantity);
  ORDERBOOK[stockSymbol][side][priceString].orders[userId] = ORDERBOOK[stockSymbol][side][priceString].orders[userId].plus(quantity);
}

function executeTrade(stockSymbol, price, quantity, buyerOrders, sellerOrders) {
  for (const [buyerId, buyQuantity] of Object.entries(buyerOrders)) {
    for (const [sellerId, sellQuantity] of Object.entries(sellerOrders)) {
      const tradeQuantity = Decimal.min(buyQuantity, sellQuantity, quantity);

      updateBalancesAfterTrade(buyerId, sellerId, stockSymbol, price, tradeQuantity);

      buyerOrders[buyerId] = buyerOrders[buyerId].minus(tradeQuantity);
      sellerOrders[sellerId] = sellerOrders[sellerId].minus(tradeQuantity);
      quantity = quantity.minus(tradeQuantity);

      if (buyerOrders[buyerId].eq(0)) delete buyerOrders[buyerId];
      if (sellerOrders[sellerId].eq(0)) delete sellerOrders[sellerId];

      if (quantity.eq(0)) return;
    }
  }
}

function updateBalancesAfterTrade(buyerId, sellerId, stockSymbol, price, quantity) {
  INR_BALANCES[buyerId].locked = INR_BALANCES[buyerId].locked.minus(quantity.times(price));
  INR_BALANCES[sellerId].balance = INR_BALANCES[sellerId].balance.plus(quantity.times(price));

  ensureStockBalanceExists(buyerId, stockSymbol);
  ensureStockBalanceExists(sellerId, stockSymbol);

  STOCK_BALANCES[buyerId][stockSymbol].yes.quantity = STOCK_BALANCES[buyerId][stockSymbol].yes.quantity.plus(quantity);
  STOCK_BALANCES[sellerId][stockSymbol].yes.locked = STOCK_BALANCES[sellerId][stockSymbol].yes.locked.minus(quantity);
}

function ensureStockBalanceExists(userId, stockSymbol) {
  if (!STOCK_BALANCES[userId][stockSymbol]) {
    STOCK_BALANCES[userId][stockSymbol] = {
      yes: { quantity: new Decimal(0), locked: new Decimal(0) },
      no: { quantity: new Decimal(0), locked: new Decimal(0) },
    };
  }
}

function matchBuyOrder(stockSymbol, stockType, decimalPrice, decimalQuantity, userId) {
  const oppositeType = stockType === "yes" ? "no" : "yes";
  const sellOrders = ORDERBOOK[stockSymbol][oppositeType];
  const sellPrices = Object.keys(sellOrders)
    .map((price) => new Decimal(price))
    .sort((a, b) => a.minus(b).toNumber());

  let remainingQuantity = decimalQuantity;
  let totalSpent = new Decimal(0);

  for (const sellPrice of sellPrices) {
    if (sellPrice.gt(decimalPrice)) break;
    const availableQuantity = sellOrders[sellPrice.toString()].total;
    const matchedQuantity = Decimal.min(remainingQuantity, availableQuantity);

    executeTrade(
      stockSymbol,
      sellPrice,
      matchedQuantity,
      { [userId]: matchedQuantity },
      sellOrders[sellPrice.toString()].orders
    );

    remainingQuantity = remainingQuantity.minus(matchedQuantity);
    totalSpent = totalSpent.plus(matchedQuantity.times(sellPrice));

    if (remainingQuantity.eq(0)) break;
  }

  return { remainingQuantity, totalSpent };
}

function placePendingBuyOrder(stockSymbol, stockType, decimalPrice, remainingQuantity, userId) {
  updateOrderbook(stockSymbol, stockType, decimalPrice, remainingQuantity, userId);
  INR_BALANCES[userId].balance = INR_BALANCES[userId].balance.minus(remainingQuantity.times(decimalPrice));
  INR_BALANCES[userId].locked = INR_BALANCES[userId].locked.plus(remainingQuantity.times(decimalPrice));
}

function matchOrders(stockSymbol) {
  if (!ORDERBOOK[stockSymbol]) return;

  const yesOrders = ORDERBOOK[stockSymbol].yes;
  const noOrders = ORDERBOOK[stockSymbol].no;

  const yesPrices = Object.keys(yesOrders)
    .map((price) => new Decimal(price))
    .filter(isValidPrice)
    .sort((a, b) => b.minus(a).toNumber());
  const noPrices = Object.keys(noOrders)
    .map((price) => new Decimal(price))
    .filter(isValidPrice)
    .sort((a, b) => a.minus(b).toNumber());

  while (yesPrices.length > 0 && noPrices.length > 0) {
    const yesPrice = yesPrices[0];
    const noPrice = noPrices[0];

    if (yesPrice.gte(noPrice)) {
      const matchPrice = yesPrice.plus(noPrice).dividedBy(2).toDecimalPlaces(2);
      const yesOrder = yesOrders[yesPrice.toString()];
      const noOrder = noOrders[noPrice.toString()];

      const matchQuantity = Decimal.min(yesOrder.total, noOrder.total);

      executeTrade(stockSymbol, matchPrice, matchQuantity, yesOrder.orders, noOrder.orders);

      yesOrder.total = yesOrder.total.minus(matchQuantity);
      noOrder.total = noOrder.total.minus(matchQuantity);

      if (yesOrder.total.eq(0)) {
        delete yesOrders[yesPrice.toString()];
        yesPrices.shift();
      }
      if (noOrder.total.eq(0)) {
        delete noOrders[noPrice.toString()];
        noPrices.shift();
      }
    } else {
      break;
    }
  }
}

function apiTest(req, res) {
  res.status(200).json({ message: "API is up and running" });
}

function resetData(req, res) {
  INR_BALANCES = {};
  ORDERBOOK = {};
  STOCK_BALANCES = {};
  res.status(200).json({ message: "Data reset successfully" });
}

function createUser(req, res) {
  const { userId } = req.params;
  initialiseUserBalances(userId);
  res.status(201).json({ message: `User ${userId} created` });
}

function createSymbol(req, res) {
  const { symbolName } = req.params;
  if (!symbolName) {
    return res.status(400).json({ message: "Symbol name is required" });
  }
  if (ORDERBOOK[symbolName]) {
    return res.status(409).json({ message: "Symbol already exists" });
  }
  ORDERBOOK[symbolName] = { yes: {}, no: {} };
  res.status(201).json({ message: `Symbol ${symbolName} created` });
}

function getINRBalance(req, res) {
  const { userId } = req.params;
  if (userId) {
    initialiseUserBalances(userId);
    res.json({
      [userId]: {
        balance: INR_BALANCES[userId].balance.toNumber(),
        locked: INR_BALANCES[userId].locked.toNumber(),
      },
    });
  } else {
    const balances = {};
    for (const [user, balance] of Object.entries(INR_BALANCES)) {
      balances[user] = {
        balance: balance.balance.toNumber(),
        locked: balance.locked.toNumber(),
      };
    }
    res.json(balances);
  }
}

function getStockBalance(req, res) {
  const { userId } = req.params;
  if (userId) {
    initialiseUserBalances(userId);
    res.json({ [userId]: STOCK_BALANCES[userId] });
  } else {
    res.json(STOCK_BALANCES);
  }
}

function onrampINR(req, res) {
  const { userId, amount } = req.body;
  if (!userId || !amount || isNaN(amount) || new Decimal(amount).lte(0)) {
    return res.status(400).json({ message: "Invalid input" });
  }
  initialiseUserBalances(userId);
  INR_BALANCES[userId].balance = INR_BALANCES[userId].balance.plus(new Decimal(amount));
  res.json({ message: `Onramped ${userId} with amount ${amount}` });
}

function buyStock(req, res) {
  const { userId, stockSymbol, quantity, price, stockType } = req.body;
  try {
    validateInput(userId, stockSymbol, quantity, price, stockType);
    checkStockSymbolExists(stockSymbol);

    initialiseUserBalances(userId);

    const decimalQuantity = new Decimal(quantity);
    const decimalPrice = new Decimal(price);
    const totalCost = decimalQuantity.times(decimalPrice);

    checkSufficientBalance(userId, totalCost);

    const { remainingQuantity, totalSpent } = matchBuyOrder(stockSymbol, stockType, decimalPrice, decimalQuantity, userId);

    if (remainingQuantity.gt(0)) {
      placePendingBuyOrder(stockSymbol, stockType, decimalPrice, remainingQuantity, userId);
    }

    INR_BALANCES[userId].balance = INR_BALANCES[userId].balance.minus(totalSpent);

    res.json({
      message: remainingQuantity.eq(0) ? "Buy order fully matched" : "Buy order partially matched",
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

function placeSellOrder(req, res) {
  const { userId, stockSymbol, quantity, price, stockType } = req.body;
  try {
    validateInput(userId, stockSymbol, quantity, price, stockType);
    initialiseUserBalances(userId);

    const decimalQuantity = new Decimal(quantity);
    const decimalPrice = new Decimal(price);

    checkSufficientStockBalance(userId, stockSymbol, stockType, decimalQuantity);

    STOCK_BALANCES[userId][stockSymbol][stockType].quantity = STOCK_BALANCES[userId][stockSymbol][stockType].quantity.minus(decimalQuantity);
    STOCK_BALANCES[userId][stockSymbol][stockType].locked = STOCK_BALANCES[userId][stockSymbol][stockType].locked.plus(decimalQuantity);
    updateOrderbook(stockSymbol, stockType, decimalPrice, decimalQuantity, userId);

    matchOrders(stockSymbol);

    res.json({
      message: `Sell order placed for ${quantity} '${stockType}' options at price ${price}`,
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

function viewOrderbook(req, res) {
  res.json(ORDERBOOK);
}

function cancelOrder(req, res) {
  const { userId, stockSymbol, quantity, price, stockType } = req.body;
  try {
    validateInput(userId, stockSymbol, quantity, price, stockType);

    const decimalQuantity = new Decimal(quantity);
    const decimalPrice = new Decimal(price);

    if (!ORDERBOOK[stockSymbol] || !ORDERBOOK[stockSymbol][stockType][decimalPrice.toString()] || !ORDERBOOK[stockSymbol][stockType][decimalPrice.toString()].orders[userId]) {
      throw new Error("Order not found");
    }

    const cancelQuantity = Decimal.min(decimalQuantity, ORDERBOOK[stockSymbol][stockType][decimalPrice.toString()].orders[userId]);

    updateOrderbookAfterCancel(stockSymbol, stockType, decimalPrice, cancelQuantity, userId);
    updateBalancesAfterCancel(userId, stockSymbol, stockType, decimalPrice, cancelQuantity);

    res.json({ message: `${stockType} order canceled` });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

function updateOrderbookAfterCancel(stockSymbol, stockType, price, quantity, userId) {
  ORDERBOOK[stockSymbol][stockType][price.toString()].total = ORDERBOOK[stockSymbol][stockType][price.toString()].total.minus(quantity);
  ORDERBOOK[stockSymbol][stockType][price.toString()].orders[userId] = ORDERBOOK[stockSymbol][stockType][price.toString()].orders[userId].minus(quantity);

  if (ORDERBOOK[stockSymbol][stockType][price.toString()].orders[userId].eq(0)) {
    delete ORDERBOOK[stockSymbol][stockType][price.toString()].orders[userId];
  }
  if (ORDERBOOK[stockSymbol][stockType][price.toString()].total.eq(0)) {
    delete ORDERBOOK[stockSymbol][stockType][price.toString()];
  }
}

function updateBalancesAfterCancel(userId, stockSymbol, stockType, price, quantity) {
  if (stockType === "yes") {
    INR_BALANCES[userId].locked = INR_BALANCES[userId].locked.minus(quantity.times(price));
    INR_BALANCES[userId].balance = INR_BALANCES[userId].balance.plus(quantity.times(price));
  } else {
    STOCK_BALANCES[userId][stockSymbol][stockType].locked = STOCK_BALANCES[userId][stockSymbol][stockType].locked.minus(quantity);
    STOCK_BALANCES[userId][stockSymbol][stockType].quantity = STOCK_BALANCES[userId][stockSymbol][stockType].quantity.plus(quantity);
  }
}

function mintTokens(req, res) {
  const { userId, stockSymbol, quantity, price } = req.body;
  try {
    validateMintTokensInput(userId, stockSymbol, quantity, price);
    initialiseUserBalances(userId);

    const decimalQuantity = new Decimal(quantity);
    const decimalPrice = new Decimal(price);
    const totalCost = decimalQuantity.times(decimalPrice);

    checkSufficientBalance(userId, totalCost);

    updateBalancesAfterMinting(userId, stockSymbol, decimalQuantity, totalCost);

    res.json({
      message: `Minted ${quantity} 'yes' and 'no' tokens for user ${userId}, remaining balance is ${INR_BALANCES[userId].balance.toNumber()}`,
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
}

function validateMintTokensInput(userId, stockSymbol, quantity, price) {
  if (!userId || !stockSymbol || !quantity || !price || new Decimal(quantity).lte(0) || !isValidPrice(price)) {
    throw new Error("Invalid input / Price must be between 1 and 10");
  }
}

function updateBalancesAfterMinting(userId, stockSymbol, quantity, totalCost) {
  INR_BALANCES[userId].balance = INR_BALANCES[userId].balance.minus(totalCost);

  if (!STOCK_BALANCES[userId][stockSymbol]) {
    STOCK_BALANCES[userId][stockSymbol] = {
      yes: { quantity: new Decimal(0), locked: new Decimal(0) },
      no: { quantity: new Decimal(0), locked: new Decimal(0) },
    };
  }

  STOCK_BALANCES[userId][stockSymbol].yes.quantity = STOCK_BALANCES[userId][stockSymbol].yes.quantity.plus(quantity);
  STOCK_BALANCES[userId][stockSymbol].no.quantity = STOCK_BALANCES[userId][stockSymbol].no.quantity.plus(quantity);
}

function viewIndividualOrderbook(req, res) {
  const { stockSymbol } = req.params;
  const orderbook = ORDERBOOK[stockSymbol];

  if (!orderbook) {
    return res.status(404).json({ error: "Orderbook with provided stock symbol not found" });
  }

  return res.json(orderbook);
}

function initialiseDummyData() {
  INR_BALANCES = {
    user1: { balance: new Decimal(10000), locked: new Decimal(0) },
    user2: { balance: new Decimal(20000), locked: new Decimal(5000) },
    user3: { balance: new Decimal(15000), locked: new Decimal(2000) },
  };

  ORDERBOOK = {
    BTC_USDT_10_Oct_2024_9_30: {
      yes: {
        9.5: {
          total: new Decimal(1200),
          orders: {
            user1: new Decimal(200),
            user2: new Decimal(1000),
          },
        },
        8.5: {
          total: new Decimal(1200),
          orders: {
            user1: new Decimal(300),
            user2: new Decimal(300),
            user3: new Decimal(600),
          },
        },
      },
      no: {
        10.5: {
          total: new Decimal(800),
          orders: {
            user2: new Decimal(500),
            user3: new Decimal(300),
          },
        },
      },
    },
  };

  STOCK_BALANCES = {
    user1: {
      BTC_USDT_10_Oct_2024_9_30: {
        yes: { quantity: new Decimal(100), locked: new Decimal(0) },
        no: { quantity: new Decimal(50), locked: new Decimal(0) },
      },
    },
    user2: {
      BTC_USDT_10_Oct_2024_9_30: {
        yes: { quantity: new Decimal(200), locked: new Decimal(100) },
        no: { quantity: new Decimal(150), locked: new Decimal(50) },
      },
    },
    user3: {
      BTC_USDT_10_Oct_2024_9_30: {
        yes: { quantity: new Decimal(150), locked: new Decimal(50) },
        no: { quantity: new Decimal(100), locked: new Decimal(0) },
      },
    },
  };
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