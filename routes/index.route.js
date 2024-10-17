const express = require("express");
const router = express.Router();
const controllers = require("../controllers/index.controller");


router.get("/", controllers.apiTest);


router.post("/user/create/:userId", controllers.createUser);
router.post("/symbol/create/:symbolName", controllers.createSymbol);
router.get("/orderbook", controllers.viewOrderbook);
router.get("/balances/inr/:userId?", controllers.getINRBalance);
router.get("/balances/stock/:userId?", controllers.getStockBalance);
router.post("/reset", controllers.resetData);
router.post("/onramp/inr", controllers.onrampINR);
router.post("/order/buy", controllers.buyStock);
router.post("/order/sell", controllers.placeSellOrder);
router.post("/order/cancel", controllers.cancelOrder);
router.get('/orderbook/:stockSymbol',controllers.viewIndividualOrderbook)
router.post("/trade/mint", controllers.mintTokens);

module.exports = router;
