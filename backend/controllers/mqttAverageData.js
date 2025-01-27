const MqttData = require('../models/mqttDataSchema'); // Existing schema
const AggregatedData = require('../models/aggregateSchema'); // Updated schema
const mqttClient = require('../mqtt'); // MQTT client setup
const WebSocket = require('ws'); // WebSocket server

const wss = new WebSocket.Server({ port: 8083 }); // WebSocket on port 8080
let clients = []; // Connected WebSocket clients
let lastSentTime = 0;
let startTime = Date.now(); // Track when the 10-minute timer starts

// WebSocket connection handler
wss.on('connection', (ws) => {
  clients.push(ws);
  console.log('New WebSocket client connected');

  ws.on('close', () => {
    clients = clients.filter(client => client !== ws);
    console.log('WebSocket client disconnected');
  });
});

// Function to send data to WebSocket clients
function sendToFrontend(data) {
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Real-time data handler
mqttClient.on('message', async (topic, message) => {
  try {
    const currentTime = Date.now();
    const elapsedMinutes = (currentTime - startTime) / (1000 * 60); // Calculate elapsed time in minutes

    if (elapsedMinutes < 10) {
      // Real-time data handling within the first 10 minutes
      if (currentTime - lastSentTime >= 10 * 1000) { // 10-second throttle
        const parsedData = message.toString().split(',').map(value => value.trim() === '' ? '0' : value);
        const realTimeData = {
          topic,
          deviceId: parsedData[0],
          values: parsedData.slice(1),
          timestamp: new Date()
        };

        // Send real-time data to frontend
        sendToFrontend(realTimeData);
        console.log('Sent real-time data:', realTimeData);

        lastSentTime = currentTime;
      }
    } else {
      console.log('Real-time period ended. Sending average data instead.');
    }
  } catch (err) {
    console.error('Error processing MQTT message:', err);
  }
});

// Function to calculate averages grouped by subtopic
async function calculateAndSendAverages() {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    // Fetch the last hour's records grouped by subtopic and deviceId
    const records = await MqttData.find({
      createdAt: { $gte: oneHourAgo },
    }).exec();

    if (records.length === 0) {
      console.log('No records found in the last hour for averaging.');
      return;
    }

    // Group records by subtopic and deviceId
    const groupedData = {};
    records.forEach(record => {
      const key = `${record.subtopic}-${record.deviceId}`;
      if (!groupedData[key]) {
        groupedData[key] = {
          subtopic: record.subtopic,
          deviceId: record.deviceId,
          records: [],
        };
      }
      groupedData[key].records.push(record);
    });

    // Calculate and send averages
    for (const groupKey of Object.keys(groupedData)) {
      const group = groupedData[groupKey];
      const { subtopic, deviceId, records } = group;

      const fields = [
        'runningHours',
        'NO2',
        'O2',
        'CO',
        'CH2O',
        'O3',
        'temperature',
        'humidity',
        'PM1',
        'PM2_5',
        'PM10',
        'CO2',
        'VOC',
        'value1',
      ];

      const averages = fields.reduce((acc, field) => {
        acc[field] =
          records.reduce((sum, record) => sum + (record[field] || 0), 0) /
          records.length;
        return acc;
      }, {});

      // Save the calculated averages to the database
      const aggregatedData = new AggregatedData({
        subtopic,
        deviceId,
        ...averages,
        calculatedAt: new Date(),
      });

      await aggregatedData.save();

      // Send the averages to WebSocket clients
      const averageDataToSend = { subtopic, deviceId, averages, timestamp: new Date() };
      sendToFrontend(averageDataToSend);
      console.log(`Sent averages for subtopic: ${subtopic}, deviceId: ${deviceId}`);
    }
  } catch (err) {
    console.error('Error calculating and sending averages:', err);
  }
}

// Schedule the average calculation every hour
setInterval(calculateAndSendAverages, 10 * 60 * 1000); // Run every hour

module.exports = calculateAndSendAverages;
