'use strict';
const { SFNClient, StartSyncExecutionCommand } = require('@aws-sdk/client-sfn');
const { prepare } = require('../index');

const sfn = new SFNClient({});
const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

exports.handler = async (event) => {
  let payload;
  try {
    payload = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || event);
  } catch (err) {
    return json(400, { errors: [{ message: 'Request body is not valid JSON.' }] });
  }

  let prepared;
  try {
    prepared = await prepare(payload);
  } catch (err) {
    if (err.name === 'ValidationError') return json(400, { errors: [{ field: err.field, message: err.message }] });
    console.error(err);
    return json(500, { errors: [{ message: 'Internal error.' }] });
  }

  try {
    const res = await sfn.send(new StartSyncExecutionCommand({
      stateMachineArn: process.env.STATE_MACHINE_ARN,
      input: JSON.stringify(prepared),
    }));
    if (res.status === 'SUCCEEDED') return json(200, res.output);   // res.output is already a JSON string
    console.error('Execution failed', res.error, res.cause);
  } catch (err) {
    console.error(err);
  }
  return json(500, { errors: [{ message: 'Internal error.' }] });
};