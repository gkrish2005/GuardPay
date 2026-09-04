import crypto from "crypto";
import { prisma } from "./db.js";

export const GENESIS_HASH = "0".repeat(64);

export interface AuditLogCreateInput {
  transactionRequestId?: string | null;
  actor: "agent" | "human" | "system";
  event: string;
  metadata?: any;
  timestamp?: Date;
}

export interface AuditLogFilter {
  transactionRequestId?: string;
  actor?: string;
  event?: string;
}

/**
 * Computes the SHA-256 digest for an audit log event chained to previousHash.
 */
export function computeEventHash(
  previousHash: string,
  eventData: {
    transactionRequestId: string | null;
    actor: string;
    event: string;
    metadata: any;
    timestamp: Date | string;
  }
): string {
  const canonicalString = `${previousHash}|${eventData.transactionRequestId || ""}|${eventData.actor}|${eventData.event}|${JSON.stringify(eventData.metadata || {})}|${new Date(eventData.timestamp).toISOString()}`;
  return crypto.createHash("sha256").update(canonicalString).digest("hex");
}

/**
 * Append-Only & Hash-Chained Audit Log Repository (Tasks 2.9 & 3.4).
 *
 * Implements:
 * 1. Strict INSERT-only enforcement at application layer (rejects UPDATE/DELETE).
 * 2. Cryptographic SHA-256 hash-chaining across historical events for post-facto tamper evidence.
 */
export class AuditLogRepository {
  private client: any;

  constructor(client: any = prisma) {
    this.client = client;
  }

  /**
   * Append a new immutable, hash-chained audit log event.
   * This is the ONLY write operation permitted by the repository.
   */
  async create(data: AuditLogCreateInput, tx?: any): Promise<any> {
    const db = tx || this.client;

    // Look up the most recent audit log to link hashes
    const latestLog = await db.auditLog.findFirst({
      orderBy: { timestamp: "desc" },
      select: { id: true, eventHash: true, timestamp: true },
    });

    const previousHash = latestLog?.eventHash || GENESIS_HASH;
    const timestamp = data.timestamp || new Date();

    const eventHash = computeEventHash(previousHash, {
      transactionRequestId: data.transactionRequestId || null,
      actor: data.actor,
      event: data.event,
      metadata: data.metadata || {},
      timestamp,
    });

    return db.auditLog.create({
      data: {
        transactionRequestId: data.transactionRequestId || null,
        actor: data.actor,
        event: data.event,
        metadata: data.metadata || {},
        previousHash,
        eventHash,
        timestamp,
      },
    });
  }

  /**
   * Cryptographically verify the integrity of the audit log hash chain.
   */
  async verifyChain(tx?: any): Promise<{
    isValid: boolean;
    brokenAtLogId?: string;
    totalVerified: number;
    error?: string;
  }> {
    const db = tx || this.client;
    const logs = await db.auditLog.findMany({
      orderBy: { timestamp: "asc" },
    });

    if (logs.length === 0) {
      return { isValid: true, totalVerified: 0 };
    }

    let expectedPreviousHash = GENESIS_HASH;

    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];

      // Check 1: previousHash link must match previous row's eventHash (or GENESIS for first row)
      if (log.previousHash !== expectedPreviousHash) {
        return {
          isValid: false,
          brokenAtLogId: log.id,
          totalVerified: i,
          error: `Broken chain link at log ${log.id}: expected previousHash ${expectedPreviousHash}, got ${log.previousHash}`,
        };
      }

      // Check 2: eventHash must match SHA256 of row contents
      const expectedEventHash = computeEventHash(log.previousHash, {
        transactionRequestId: log.transactionRequestId,
        actor: log.actor,
        event: log.event,
        metadata: log.metadata,
        timestamp: log.timestamp,
      });

      if (log.eventHash !== expectedEventHash) {
        return {
          isValid: false,
          brokenAtLogId: log.id,
          totalVerified: i,
          error: `Tampered payload hash at log ${log.id}: expected eventHash ${expectedEventHash}, got ${log.eventHash}`,
        };
      }

      expectedPreviousHash = log.eventHash;
    }

    return { isValid: true, totalVerified: logs.length };
  }

  /**
   * Read audit logs chronologically with optional filtering or Prisma query options.
   */
  async findMany(args?: any, tx?: any): Promise<any[]> {
    const db = tx || this.client;
    if (
      args &&
      (args.where !== undefined ||
        args.orderBy !== undefined ||
        args.take !== undefined ||
        args.skip !== undefined ||
        args.select !== undefined)
    ) {
      return db.auditLog.findMany(args);
    }
    return db.auditLog.findMany({
      where: args,
      orderBy: { timestamp: "asc" },
    });
  }

  /**
   * Read the first matching audit log event.
   */
  async findFirst(args: any, tx?: any): Promise<any | null> {
    const db = tx || this.client;
    if (args && (args.where !== undefined || args.orderBy !== undefined || args.select !== undefined)) {
      return db.auditLog.findFirst(args);
    }
    return db.auditLog.findFirst({ where: args });
  }

  /**
   * Count audit log events.
   */
  async count(args?: any, tx?: any): Promise<number> {
    const db = tx || this.client;
    if (args && (args.where !== undefined || args.select !== undefined)) {
      return db.auditLog.count(args);
    }
    return db.auditLog.count({ where: args });
  }

  // Runtime guard stubs preventing any dynamic bypass
  update(): never {
    throw new Error("AuditLog is append-only: UPDATE operations are forbidden at the application layer");
  }

  updateMany(): never {
    throw new Error("AuditLog is append-only: UPDATE operations are forbidden at the application layer");
  }

  delete(): never {
    throw new Error("AuditLog is append-only: DELETE operations are forbidden at the application layer");
  }

  deleteMany(): never {
    throw new Error("AuditLog is append-only: DELETE operations are forbidden at the application layer");
  }
}

export const auditLogRepository = new AuditLogRepository();
export const writeAuditLog = (data: AuditLogCreateInput, tx?: any) => auditLogRepository.create(data, tx);
