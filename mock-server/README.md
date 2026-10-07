# Fast & Reliable Bank Mock Server

A tiny Express server to simulate transaction processing for local testing.

Getting started:

1. Change to the mock-server folder:

```powershell
cd mock-server
```

2. Install dependencies:

```powershell
npm install
```

3. Start the server:

```powershell
npm start
```

By default the server runs on port 3333. It exposes:

- GET / -> simple index page
- POST /process-tx -> accepts JSON payload { id, user, amount, type, phone, plan, biller } and returns { status: 'success'|'failed'|'pending', ref }

Use the server URL in the dashboard Settings as `http://localhost:3333/process-tx`.
