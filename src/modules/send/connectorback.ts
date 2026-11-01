import { pullLook } from "../../conversation/ledger.ts";
import { OWNER_CONV } from "../../core/convpaths.ts";

// A connector that was down is connected again (connectors.ts recordConnectors): the owner's next look (the only conversation with connectors) is pulled forward to finish what the outage blocked.
export const connectorBack = (label: string): string => pullLook(OWNER_CONV, 2, `${label} is connected again: finish what it blocked earlier in the chat or a look`);
