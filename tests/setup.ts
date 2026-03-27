import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import path from "node:path";

let container: StartedTestContainer | undefined;

export async function setup(): Promise<void> {
  const dockerfilePath = path.resolve(process.cwd(), "docker");

  const image = await GenericContainer.fromDockerfile(dockerfilePath).build(
    "engram-db:test",
    { deleteOnExit: false },
  );

  container = await image
    .withEnvironment({ POSTGRES_PASSWORD: "test", POSTGRES_DB: "agent_memory" })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);

  // Expose connection string for all integration/db tests
  process.env.ENGRAM_TEST_DB = `postgresql://postgres:test@${host}:${port}/agent_memory`;
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
