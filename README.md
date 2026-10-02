# Kromax

Ticker forecasting with a Node.js API, AngularJS interface, and the Kronos financial foundation model.

```text
workspace/
├── Kronos/   # Independent upstream clone, ignored by this repository
└── kromax/   # Application source and its local Python environment
```

## Run

From this workspace, with dependencies already installed:

```bash
cd kromax
npm start
```

Open http://localhost:3000. Stop with Ctrl+C.

For a fresh clone, obtain the upstream model source separately:

```bash
git clone https://github.com/shiyu-coder/Kronos.git Kronos
```

Then follow [the application's installation instructions](kromax/README.md). Set `KRONOS_REPO=/absolute/path/to/Kronos` if the upstream source is stored elsewhere.

Update the upstream checkout independently with `git -C Kronos pull --ff-only`, then restart the application. This repository tracks the workspace documentation and `kromax/` source; it does not vendor the Kronos checkout, installed dependencies, model weights, or generated test results.
