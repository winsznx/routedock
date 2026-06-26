import { MppSessionClient } from "@routedock/routedock"
import { Keypair } from "@stellar/stellar-sdk"

const AGENT_SECRET = process.env.AGENT_SECRET!
const COMMITMENT_SECRET =
  process.env.COMMITMENT_SECRET!

const TEST_URL =
  "https://your-test-url"

const PAYMENTS_PER_SESSION = 1
const ENABLE_DISPUTE = false
const SESSIONS = 1

const manifest = {}

const metrics = {
  open: [] as number[],
  payment: [] as number[],
  close: [] as number[],
  disputes: 0,
  failures: 0
}

async function runSession(
  id: number
) {
  let session: any = null

  try {
    await new Promise(r =>
      setTimeout(
        r,
        Math.random() * 1000
      )
    )

    const client =
      new MppSessionClient(
        Keypair.fromSecret(
          AGENT_SECRET
        ),
        "testnet"
      )

    console.log(
      `agent ${id}: opening session`
    )

    const openStart =
      performance.now()

    session =
      await client.openSession(
        TEST_URL,
        manifest,
        COMMITMENT_SECRET
      )

    metrics.open.push(
      performance.now() -
      openStart
    )

    console.log(
      `agent ${id}: session opened`
    )

    console.log(
      `agent ${id}: session data`,
      {
        contractId:
          session?.contractId,
        sessionKeys:
          Object.keys(
            session || {}
          )
      }
    )

    const contractId =
      session?.contractId

    const validContract =
      contractId &&
      /^C[A-Z0-9]{55}$/.test(
        contractId
      )

    if (validContract) {

      console.log(
        `agent ${id}: closing session`
      )

      const closeStart =
        performance.now()

      await session.close()

      metrics.close.push(
        performance.now() -
        closeStart
      )
    }

    console.log(
      `agent ${id}: complete`
    )

  } catch (err) {

    metrics.failures++

    console.error(
      `agent ${id} failed`
    )

    console.error(err)
  }
}

async function main() {
  await Promise.all(
    Array.from(
      { length: SESSIONS },
      (_, i) => runSession(i)
    )
  )

  console.log(
    "finished",
    metrics
  )
}

main()