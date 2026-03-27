import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, type EngramPool } from "../../src/db/connection.js";
import { initializeDatabase } from "../../src/db/init.js";
import { loadConfig } from "../../src/config.js";
import { SchemaManager } from "../../src/schema/manager.js";
import {
  createOrUpdateEntity,
  getEntity,
  softDeleteEntity,
  mergeEntities,
} from "../../src/graph/entities.js";
import {
  createRelationship,
  getRelationships,
} from "../../src/graph/relationships.js";

describe("entity CRUD", () => {
  let pool: EngramPool;
  let schema: SchemaManager;
  const graphName = "entity_test";

  beforeAll(async () => {
    const testDb = process.env.ENGRAM_TEST_DB;
    if (!testDb) {
      throw new Error("ENGRAM_TEST_DB not set");
    }

    const url = new URL(testDb);
    const config = loadConfig({
      mode: "external",
      external: {
        host: url.hostname,
        port: parseInt(url.port, 10),
        database: url.pathname.slice(1),
        username: url.username,
        password: url.password,
        ssl: false,
        graph_name: graphName,
      },
    });

    pool = await createPool(config);
    await initializeDatabase(pool);
    schema = SchemaManager.fromPreset("dev-team");
  });

  afterAll(async () => {
    if (pool) {
      try {
        await pool.query(`SELECT drop_graph('${graphName}', true)`);
      } catch {
        // Graph may not exist
      }
      await pool.close();
    }
  });

  describe("createOrUpdateEntity", () => {
    it("creates a new entity with server-issued UUID", async () => {
      const result = await createOrUpdateEntity(pool, schema, {
        name: "Alice",
        type: "Person",
        properties: { role: "CTO" },
      });

      expect(result.created).toBe(true);
      expect(result.name).toBe("Alice");
      expect(result.type).toBe("Person");
      expect(result.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(result.properties.role).toBe("CTO");
      expect(result.properties.created_at).toBeDefined();
    });

    it("upserts an existing entity (merge properties)", async () => {
      // Create first
      const first = await createOrUpdateEntity(pool, schema, {
        name: "Bob",
        type: "Person",
        properties: { role: "Engineer", team: "Backend" },
      });
      expect(first.created).toBe(true);

      // Upsert with new properties
      const second = await createOrUpdateEntity(pool, schema, {
        name: "Bob",
        type: "Person",
        properties: { role: "Senior Engineer", email: "bob@test.com" },
      });

      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id); // Same entity
      expect(second.properties.role).toBe("Senior Engineer"); // Overwritten
      expect(second.properties.team).toBe("Backend"); // Retained
      expect(second.properties.email).toBe("bob@test.com"); // New
      expect(second.properties.updated_at).toBeDefined();
    });

    it("stores confidence value", async () => {
      const result = await createOrUpdateEntity(pool, schema, {
        name: "ConfidenceTest",
        type: "Person",
        confidence: 0.85,
      });

      expect(result.created).toBe(true);
      expect(result.properties.confidence).toBe(0.85);
    });

    it("rejects empty name", async () => {
      await expect(
        createOrUpdateEntity(pool, schema, { name: "", type: "Person" }),
      ).rejects.toThrow("Entity name cannot be empty");
    });

    it("rejects whitespace-only name", async () => {
      await expect(
        createOrUpdateEntity(pool, schema, { name: "   ", type: "Person" }),
      ).rejects.toThrow("Entity name cannot be empty");
    });

    it("rejects invalid entity type", async () => {
      await expect(
        createOrUpdateEntity(pool, schema, {
          name: "Test",
          type: "InvalidType",
        }),
      ).rejects.toThrow('Invalid entity type: "InvalidType"');
    });

    it("rejects confidence < 0", async () => {
      await expect(
        createOrUpdateEntity(pool, schema, {
          name: "Test",
          type: "Person",
          confidence: -0.1,
        }),
      ).rejects.toThrow("Confidence must be between 0.0 and 1.0");
    });

    it("rejects confidence > 1", async () => {
      await expect(
        createOrUpdateEntity(pool, schema, {
          name: "Test",
          type: "Person",
          confidence: 1.1,
        }),
      ).rejects.toThrow("Confidence must be between 0.0 and 1.0");
    });

    it("trims whitespace from name", async () => {
      const result = await createOrUpdateEntity(pool, schema, {
        name: "  Charlie  ",
        type: "Person",
      });

      expect(result.name).toBe("Charlie");
    });

    it("creates entities of different types", async () => {
      const project = await createOrUpdateEntity(pool, schema, {
        name: "Project Atlas",
        type: "Project",
        properties: { status: "active" },
      });

      expect(project.created).toBe(true);
      expect(project.type).toBe("Project");
    });

    it("treats same name + different type as different entities", async () => {
      const person = await createOrUpdateEntity(pool, schema, {
        name: "Atlas",
        type: "Person",
      });
      const project = await createOrUpdateEntity(pool, schema, {
        name: "Atlas",
        type: "Project",
      });

      expect(person.id).not.toBe(project.id);
      expect(person.type).toBe("Person");
      expect(project.type).toBe("Project");
    });
  });

  describe("getEntity", () => {
    let testEntityId: string;

    beforeAll(async () => {
      const result = await createOrUpdateEntity(pool, schema, {
        name: "Diana",
        type: "Person",
        properties: { role: "Designer" },
      });
      testEntityId = result.id;
    });

    it("retrieves entity by UUID", async () => {
      const entity = await getEntity(pool, schema, testEntityId);

      expect(entity).not.toBeNull();
      expect(entity!.id).toBe(testEntityId);
      expect(entity!.name).toBe("Diana");
      expect(entity!.type).toBe("Person");
    });

    it("retrieves entity by name", async () => {
      const entity = await getEntity(pool, schema, "Diana");

      expect(entity).not.toBeNull();
      expect(entity!.id).toBe(testEntityId);
      expect(entity!.name).toBe("Diana");
    });

    it("returns null for non-existent UUID", async () => {
      const entity = await getEntity(
        pool,
        schema,
        "00000000-0000-0000-0000-000000000000",
      );
      expect(entity).toBeNull();
    });

    it("returns null for non-existent name", async () => {
      const entity = await getEntity(pool, schema, "NonExistentPerson12345");
      expect(entity).toBeNull();
    });
  });

  describe("softDeleteEntity", () => {
    it("soft-deletes an entity", async () => {
      const created = await createOrUpdateEntity(pool, schema, {
        name: "ToDelete",
        type: "Person",
      });

      const result = await softDeleteEntity(pool, schema, created.id);

      expect(result.id).toBe(created.id);
      expect(result.deleted).toBe(true);

      // Entity should no longer be found
      const fetched = await getEntity(pool, schema, created.id);
      expect(fetched).toBeNull();
    });

    it("throws for non-existent entity", async () => {
      await expect(
        softDeleteEntity(pool, schema, "00000000-0000-0000-0000-000000000000"),
      ).rejects.toThrow("Entity not found");
    });
  });

  describe("mergeEntities", () => {
    it("merges two entities of the same type", async () => {
      const entity1 = await createOrUpdateEntity(pool, schema, {
        name: "MergeA",
        type: "Person",
        properties: { role: "Lead", team: "A" },
      });
      const entity2 = await createOrUpdateEntity(pool, schema, {
        name: "MergeB",
        type: "Person",
        properties: { role: "Member", email: "b@test.com" },
      });

      const result = await mergeEntities(
        pool,
        schema,
        entity1.id,
        entity2.id,
      );

      expect(result.surviving_id).toBe(entity1.id);
      expect(result.merged_id).toBe(entity2.id);

      // Surviving entity has merged properties (surviving takes precedence)
      const surviving = await getEntity(pool, schema, entity1.id);
      expect(surviving).not.toBeNull();
      expect(surviving!.properties.role).toBe("Lead"); // surviving wins
      expect(surviving!.properties.email).toBe("b@test.com"); // from merged
      expect(surviving!.properties.merged_from).toBe(entity2.id);

      // Merged entity is soft-deleted
      const merged = await getEntity(pool, schema, entity2.id);
      expect(merged).toBeNull();
    });

    it("rejects merging entities of different types", async () => {
      const person = await createOrUpdateEntity(pool, schema, {
        name: "MergeTypePerson",
        type: "Person",
      });
      const project = await createOrUpdateEntity(pool, schema, {
        name: "MergeTypeProject",
        type: "Project",
      });

      await expect(
        mergeEntities(pool, schema, person.id, project.id),
      ).rejects.toThrow("Cannot merge entities of different types");
    });

    it("rejects merging entity with itself", async () => {
      const entity = await createOrUpdateEntity(pool, schema, {
        name: "MergeSelf",
        type: "Person",
      });

      await expect(
        mergeEntities(pool, schema, entity.id, entity.id),
      ).rejects.toThrow("Cannot merge an entity with itself");
    });

    it("rejects merging non-existent entity", async () => {
      const entity = await createOrUpdateEntity(pool, schema, {
        name: "MergeExists",
        type: "Person",
      });

      await expect(
        mergeEntities(
          pool,
          schema,
          entity.id,
          "00000000-0000-0000-0000-000000000000",
        ),
      ).rejects.toThrow("Merged entity not found");
    });

    it("transfers relationships with properties preserved", async () => {
      const entityA = await createOrUpdateEntity(pool, schema, {
        name: "MergeTransferA",
        type: "Person",
      });
      const entityB = await createOrUpdateEntity(pool, schema, {
        name: "MergeTransferB",
        type: "Person",
      });
      const target = await createOrUpdateEntity(pool, schema, {
        name: "MergeTransferTarget",
        type: "Project",
      });

      // Create relationship from B to target with properties
      await createRelationship(pool, schema, {
        from: entityB.id,
        to: target.id,
        type: "OWNS",
        properties: { role: "lead", since: "2024" },
      });

      // Merge B into A
      const result = await mergeEntities(pool, schema, entityA.id, entityB.id);
      expect(result.relationships_transferred).toBe(1);

      // Verify A now has the relationship with properties
      const rels = await getRelationships(pool, schema, entityA.id, {
        direction: "out",
        type_filter: "OWNS",
      });
      expect(rels.relationships.length).toBe(1);
      expect(rels.relationships[0].properties.role).toBe("lead");
      expect(rels.relationships[0].properties.since).toBe("2024");
    });

    it("skips transfer on collision — surviving edge takes precedence", async () => {
      const survivor = await createOrUpdateEntity(pool, schema, {
        name: "CollisionSurvivor",
        type: "Person",
      });
      const merged = await createOrUpdateEntity(pool, schema, {
        name: "CollisionMerged",
        type: "Person",
      });
      const target = await createOrUpdateEntity(pool, schema, {
        name: "CollisionTarget",
        type: "Project",
      });

      // Both entities have OWNS edge to the same target, with different properties
      await createRelationship(pool, schema, {
        from: survivor.id,
        to: target.id,
        type: "OWNS",
        properties: { role: "owner" },
      });
      await createRelationship(pool, schema, {
        from: merged.id,
        to: target.id,
        type: "OWNS",
        properties: { role: "contributor" },
      });

      // Merge — collision should be skipped
      const result = await mergeEntities(pool, schema, survivor.id, merged.id);
      expect(result.relationships_transferred).toBe(0); // collision skipped

      // Verify survivor's edge preserved with original props
      const rels = await getRelationships(pool, schema, survivor.id, {
        direction: "out",
        type_filter: "OWNS",
      });
      expect(rels.relationships.length).toBe(1);
      expect(rels.relationships[0].properties.role).toBe("owner"); // survivor's props
    });
  });

  describe("UUID identity", () => {
    it("uses server-issued UUID for identity", async () => {
      const result1 = await createOrUpdateEntity(pool, schema, {
        name: "UUID-Test-1",
        type: "Person",
      });
      const result2 = await createOrUpdateEntity(pool, schema, {
        name: "UUID-Test-2",
        type: "Person",
      });

      expect(result1.id).not.toBe(result2.id);
      expect(result1.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(result2.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("client cannot override the server-issued UUID", async () => {
      const clientUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const result = await createOrUpdateEntity(pool, schema, {
        name: "UUID-Override-Test",
        type: "Person",
        properties: { id: clientUuid },
      });

      // Server should issue its own UUID, not use the client-provided one
      // The entity is created, but the property id is the server-issued one
      expect(result.id).not.toBe(clientUuid);
    });
  });

  describe("name collision handling", () => {
    it("same name + same type = upsert", async () => {
      const first = await createOrUpdateEntity(pool, schema, {
        name: "Collision-Same",
        type: "Person",
      });
      const second = await createOrUpdateEntity(pool, schema, {
        name: "Collision-Same",
        type: "Person",
      });

      expect(first.id).toBe(second.id);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
    });

    it("same name + different type = separate entities", async () => {
      const person = await createOrUpdateEntity(pool, schema, {
        name: "Collision-DiffType",
        type: "Person",
      });
      const project = await createOrUpdateEntity(pool, schema, {
        name: "Collision-DiffType",
        type: "Project",
      });

      expect(person.id).not.toBe(project.id);
      expect(person.created).toBe(true);
      expect(project.created).toBe(true);
    });
  });
});
