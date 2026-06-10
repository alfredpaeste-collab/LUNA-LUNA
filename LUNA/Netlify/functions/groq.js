exports.handler = async function(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const keys = [
    process.env.KEY_1,
    process.env.KEY_2,
    process.env.KEY_3,
    process.env.KEY_4,
    process.env.KEY_5,
    process.env.KEY_6,
    process.env.KEY_7,
    process.env.KEY_8,
    process.env.KEY_9,
    process.env.KEY_10,
  ].filter(Boolean);

  if (!keys.length) {
    return { statusCode: 500, body: JSON.stringify({ error: 'No API keys configured' }) };
  }

  const key = keys[Math.floor(Math.random() * keys.length)];

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: event.body
  });

  const data = await response.json();

  return {
    statusCode: response.status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  };
};