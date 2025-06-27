const express = require('express');
const bodyParser = require('body-parser');
const { generatePDF, generateHTML } = require('./index');
const app = express();
const port = 8080;

app.use(bodyParser.raw({ limit: '100mb', type: 'text/html' }));

app.post('/pdf_visualiser', async (req, res) => {
  const htmlPage = req.body;
  const rapportType = req.query.report;
  if (!htmlPage) {
    return res.status(400).send('Request body is empty.');
  }

  try {
    res.setHeader('Content-Type', 'application/pdf');
    const html = await generateHTML(htmlPage.toString());
    const pdf = await generatePDF(html);
    res.send(pdf);
  } catch (error) {
    console.error('Error generating PDF:', error);
    res.status(500).send('Error generating PDF');
  }
});

app.post('/html_visualiser', async (req, res) => {
  const htmlPage = req.body;
  const rapportType = req.query.report;
  if (!htmlPage) {
    return res.status(400).send('Request body is empty.');
  }

  try {
    res.setHeader('Content-Type', 'text/html');
    const html = await generateHTML(htmlPage.toString());
    res.send(await html.content());
  } catch (error) {
    console.error('Error generating PDF:', error);
    res.status(500).send('Error generating PDF');
  }
});

app.listen(port, (error) => {
  console.log(`PDF visualiser server listening on port ${port}`);
  if (error) console.log(error);
});
