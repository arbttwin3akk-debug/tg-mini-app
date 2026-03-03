const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;

const publicDir = path.join(__dirname, 'webapp');

app.use(express.static(publicDir));

app.get('/*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Web app is available at http://localhost:${PORT}`);
});

