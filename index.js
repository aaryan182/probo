const express = require('express');
const routes = require('./routes/index.route');
const app = express();
const port = 3000;
const { initialiseDummyData } = require('./controllers/index.controller');

app.use(express.json());

initialiseDummyData();

app.use('/', routes);

app.listen(port, () => {
    console.log(`Options trading app listening at http://localhost:${port}`);
});
