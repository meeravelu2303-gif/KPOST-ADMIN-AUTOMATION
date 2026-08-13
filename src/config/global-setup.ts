import { resetBugLedger } from '../utils/bugTracker';

async function globalSetup(): Promise<void> {
  resetBugLedger();
}

export default globalSetup;
