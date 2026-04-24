'use strict';

const axios = require('axios');

const PHONE_NUMBER_ID = '1052714317930764';
const ACCESS_TOKEN    = 'EAAaNDdZBidpYBRU1n8ysGM0cwrZAcixmnUeJSZB3E7pVmCZBI7zdJny2Saljup60rTuo3cf5stMZCCzZBimLa4v1riA1ne2ewZA41Gxv2TUFLwM8PJHXtdq8CObInODZAbQeJ1HTRZBYSpeKaKa9NGPB6g21UXr5PuC8daHRsw5lRy2FwgQIOw0BpZArZCBLHkE9bf1KDmzAIeCQ8glgCkudeAhy0NsG2bZAqmQJ995PL5vtnymdNonPllkAPMgqnJ8u81bat9RJh1Ucl8DCqnPs5l14h6TQ';
const RECIPIENT      = '2347060457660';

const payload = {
  messaging_product: 'whatsapp',
  to: RECIPIENT,
  type: 'template',
  template: {
    name: 'bizpulse',
    language: { code: 'en_US' },
    components: [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Amaka Stores'    }, // {{1}}
          { type: 'text', text: '22nd April 2026' }, // {{2}}
          { type: 'text', text: '15'              }, // {{3}}
        ],
      },
    ],
  },
};

async function sendTemplate() {
  console.log('Sending template message...');
  console.log('To:', RECIPIENT);
  console.log('Template: bizpulse_stock (en)');
  console.log('Parameters: Amaka Stores | 22nd April 2026 | 15\n');

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('✅ Success!');
    console.log('Response:', JSON.stringify(response.data, null, 2));
  } catch (err) {
    console.error('❌ Failed');
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Full error response:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('Error:', err.message);
    }
    process.exit(1);
  }
}

sendTemplate();
