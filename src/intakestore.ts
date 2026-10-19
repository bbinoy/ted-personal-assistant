import type { Data, OpenBao } from "./openbao.ts";
import { cvcProblem, ITEM_NAME, SecretsError, TENANT_ID } from "./secrets.ts";
import type { Put } from "./intakepurposes.ts";

// The intake page's way into OpenBao: it can write an item and nothing else (there is no read, list or delete here, and the page's token is
// write-only in OpenBao too, openbaoadmin.ts INTAKE_ROLE). It does not use TenantSecrets, which also reads, and which refuses a card for a tenant
// altogether; the rule that matters here is the one the card store keeps: a friend's security code is never written.

export const WRITE_KINDS = ["profile", "card", "google"] as const;
export type WriteKind = (typeof WRITE_KINDS)[number];

export class IntakeWriter {
  private readonly bao: OpenBao;
  constructor(bao: OpenBao) {
    this.bao = bao;
  }

  // The writer for one tenant's items.
  for(tenant: string): Put {
    if (!TENANT_ID.test(tenant)) throw new SecretsError("not a tenant id");
    return async (kind: WriteKind, name: string, data: Data) => {
      if (!WRITE_KINDS.includes(kind)) throw new SecretsError("not a kind of secret item");
      if (!ITEM_NAME.test(name)) throw new SecretsError("not a valid item name");
      const problem = kind === "card" ? cvcProblem(tenant, data) : undefined;
      if (problem) throw new SecretsError(problem);
      await this.bao.write(`tenants/${tenant}/${kind}/${name}`, data);
    };
  }
}
