"use strict";

const {
  ACTION_CODES,
  ACTION_LABELS,
  buildFingerprint,
  stampFingerprint,
  actorFromRequest,
  normaliseActor,
} = require("../../utils/fingerprint");

describe("fingerprint utility", () => {
  describe("buildFingerprint", () => {
    it("emits all required fields for a known action", () => {
      const fp = buildFingerprint(ACTION_CODES.ORDER_CREATED, {
        entityId: "abc123",
        actor:    { id: "u1", name: "Alice", role: "admin" },
        meta:     { po: "PO-1" },
      });
      expect(fp.code).toBe("ORDER_CREATED");
      expect(fp.label).toBe(ACTION_LABELS.ORDER_CREATED);
      expect(fp.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(fp.shortId).toBe(fp.hash.slice(0, 10).toUpperCase());
      expect(fp.actor).toEqual({ id: "u1", name: "Alice", role: "admin" });
      expect(fp.meta).toEqual({ po: "PO-1" });
      expect(fp.at).toBeInstanceOf(Date);
    });

    it("produces a different hash for two calls with identical input", () => {
      const a = buildFingerprint(ACTION_CODES.ORDER_APPROVED, { entityId: "x" });
      const b = buildFingerprint(ACTION_CODES.ORDER_APPROVED, { entityId: "x" });
      expect(a.hash).not.toBe(b.hash);
    });

    it("rejects unknown action codes", () => {
      expect(() => buildFingerprint("NOT_A_THING", { entityId: "x" })).toThrow();
    });

    it("defaults the actor to System when omitted", () => {
      const fp = buildFingerprint(ACTION_CODES.JOB_CREATED, { entityId: "z" });
      expect(fp.actor).toEqual({ id: "system", name: "System", role: "system" });
    });
  });

  describe("normaliseActor", () => {
    it("handles null/undefined", () => {
      expect(normaliseActor(null)).toEqual({
        id: "system", name: "System", role: "system",
      });
    });

    it("normalises a string actor", () => {
      const a = normaliseActor("alice");
      expect(a.id).toBe("alice");
      expect(a.name).toBe("alice");
    });

    it("preserves id/name/role from a plain object", () => {
      const a = normaliseActor({ id: "u1", name: "Bob", role: "manager" });
      expect(a).toEqual({ id: "u1", name: "Bob", role: "manager" });
    });

    it("converts _id (Mongoose) into id", () => {
      const a = normaliseActor({ _id: { toString: () => "objectid1" }, name: "C", role: "admin" });
      expect(a.id).toBe("objectid1");
    });

    it("includes email when present", () => {
      const a = normaliseActor({ id: "u", name: "D", role: "r", email: "d@x.com" });
      expect(a.email).toBe("d@x.com");
    });
  });

  describe("actorFromRequest", () => {
    it("prefers req.user when present", () => {
      const a = actorFromRequest({
        user: { _id: { toString: () => "uid" }, name: "JWTUser", role: "admin" },
        body: { actor: { id: "x", name: "BodyUser", role: "guest" } },
      });
      expect(a.id).toBe("uid");
      expect(a.name).toBe("JWTUser");
    });

    it("falls back to body.actor", () => {
      const a = actorFromRequest({
        body: { actor: { id: "x", name: "BodyUser", role: "guest" } },
      });
      expect(a.name).toBe("BodyUser");
    });

    it("falls back to actorId/actorName fields", () => {
      const a = actorFromRequest({
        body: { actorId: "u9", actorName: "Inline", actorRole: "operator" },
      });
      expect(a.id).toBe("u9");
      expect(a.name).toBe("Inline");
      expect(a.role).toBe("operator");
    });

    it("returns System when nothing supplied", () => {
      expect(actorFromRequest({})).toEqual({
        id: "system", name: "System", role: "system",
      });
    });
  });

  describe("stampFingerprint", () => {
    it("pushes onto doc.fingerprints and returns the fingerprint", () => {
      const doc = { _id: "order1", fingerprints: [] };
      const fp = stampFingerprint(doc, ACTION_CODES.ORDER_APPROVED, {
        req: { user: { id: "u1", name: "Alice", role: "admin" } },
        meta: { forced: true },
      });
      expect(doc.fingerprints).toHaveLength(1);
      expect(doc.fingerprints[0]).toBe(fp);
      expect(fp.code).toBe("ORDER_APPROVED");
      expect(fp.meta).toEqual({ forced: true });
      expect(fp.actor.name).toBe("Alice");
    });

    it("defaults entityId to doc._id", () => {
      const doc = { _id: "job42", fingerprints: [] };
      const fp = stampFingerprint(doc, ACTION_CODES.JOB_CREATED);
      // entityId feeds the hash; two different ids → different hashes.
      const other = buildFingerprint(ACTION_CODES.JOB_CREATED, { entityId: "different" });
      expect(fp.hash).not.toBe(other.hash);
    });

    it("explicit actor wins over req", () => {
      const doc = { _id: "x", fingerprints: [] };
      const fp = stampFingerprint(doc, ACTION_CODES.ORDER_CREATED, {
        req: { user: { name: "FromReq" } },
        actor: { id: "e", name: "Explicit", role: "admin" },
      });
      expect(fp.actor.name).toBe("Explicit");
    });

    it("initialises fingerprints when the array is absent", () => {
      const doc = { _id: "y" };
      stampFingerprint(doc, ACTION_CODES.ORDER_CREATED);
      expect(Array.isArray(doc.fingerprints)).toBe(true);
      expect(doc.fingerprints).toHaveLength(1);
    });

    it("defaults the actor to System when neither actor nor req given", () => {
      const doc = { _id: "z", fingerprints: [] };
      const fp = stampFingerprint(doc, ACTION_CODES.ORDER_CREATED);
      expect(fp.actor).toEqual({ id: "system", name: "System", role: "system" });
    });

    it("is behaviour-equivalent to the manual build-and-push idiom", () => {
      // The old idiom vs the helper produce the same shape (minus
      // hash/at which are nonce/time based).
      const req = { user: { id: "u1", name: "Alice", role: "admin" } };
      const doc = { _id: "order1", fingerprints: [] };
      const manual = buildFingerprint(ACTION_CODES.RAW_MATERIAL_DEDUCTED, {
        entityId: doc._id, actor: actorFromRequest(req), meta: { applied: 5 },
      });
      const helper = stampFingerprint(doc, ACTION_CODES.RAW_MATERIAL_DEDUCTED, {
        req, meta: { applied: 5 },
      });
      expect(helper.code).toBe(manual.code);
      expect(helper.label).toBe(manual.label);
      expect(helper.actor).toEqual(manual.actor);
      expect(helper.meta).toEqual(manual.meta);
    });
  });
});
