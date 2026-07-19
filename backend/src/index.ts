import app from "./app";
import { fundRelayerIfNecessary } from "./lib/contracts";
import { startReconciliationJob } from "./lib/reconciliation";

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`[Restock Protocol API] Service running on http://localhost:${PORT}`);
  await fundRelayerIfNecessary();
  startReconciliationJob();
});
