const express = require("express");
const router = express.Router();
const controllers = require("../controllers/index.controller");


router.get("/", controllers.apiTest);


router.post("/reset", controllers.resetData);
router.post("/user/create/:userId", controllers.createUser);
router.post("/symbol/create/:symbolName", controllers.createStock);
router.get("/balances/inr/:userId?", controllers.getINRBalance);
router.post("/onramp/inr", controllers.onrampINR);
router.get("/balances/stock/:userId?", controllers.getStockBalance);
router.post("/order/buy", controllers.buyStock);
router.post("/order/sell", controllers.placeSellOrder);
router.get("/orderbook", controllers.viewOrderbook);
router.post("/order/cancel", controllers.cancelOrder);
router.post("/trade/mint", controllers.mintTokens);

module.exports = router;
