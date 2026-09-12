import "server-only";

import { COLLECTIONS } from "@/lib/model";
import { db } from "./firestore";

/** The Admin SDK's view of the collections the scripts touch.
 *
 *  Only the two. Everything else is written from the browser under
 *  `firestore.rules`; the admin credential exists for the one job the rules
 *  cannot do, which is create the first account before any account exists to
 *  create it.
 */
export const users = () => db().collection(COLLECTIONS.users);
export const userAuditEvents = () => db().collection(COLLECTIONS.userAuditEvents);

export type { UserDoc, UserAuditEventDoc } from "@/lib/model";
