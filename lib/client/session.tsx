"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { onAuthStateChanged, signOut as firebaseSignOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";

import { isRole, type Role } from "@/lib/domain/roles";
import { clientAuth, clientDb } from "@/lib/client/firebase";
import { COLLECTIONS, type UserDoc } from "@/lib/model";

export interface SessionUser {
  /** The Firebase uid, which is also this account's document id — and the
   *  value `firestore.rules` compares every signature against. */
  uid: string;
  email: string;
  displayName: string;
  role: Role;
  employeeNo: string | null;
}

interface SessionState {
  user: SessionUser | null;
  /** True until Firebase has restored (or ruled out) a stored session. Pages
   *  must wait for this before deciding somebody is signed out, or every
   *  reload would bounce through the login screen. */
  loading: boolean;
  /** Set when Firebase knows the person but this plant does not, or has
   *  deactivated them. Worth telling them apart from "wrong password". */
  rejection: string | null;
}

const SessionContext = createContext<SessionState>({
  user: null,
  loading: true,
  rejection: null,
});

/** Who is signed in, resolved once and shared by every page.
 *
 *  Firebase answers "who is this". The user document answers "may they work
 *  here", and it is read fresh on every sign-in and every reload rather than
 *  trusted from the token — so an account deactivated this morning is locked
 *  out this morning, not whenever its credential happens to lapse.
 *
 *  None of this is a security boundary. It decides what the interface offers;
 *  `firestore.rules` decides what the database accepts, and it re-reads the
 *  same document server-side on every single operation. If the two ever
 *  disagree, the person gets a control that fails when they use it — annoying,
 *  but not a way in.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({
    user: null,
    loading: true,
    rejection: null,
  });

  useEffect(() => {
    return onAuthStateChanged(clientAuth(), async (firebaseUser) => {
      if (!firebaseUser) {
        setState({ user: null, loading: false, rejection: null });
        return;
      }

      try {
        const snapshot = await getDoc(
          doc(clientDb(), COLLECTIONS.users, firebaseUser.uid)
        );

        if (!snapshot.exists()) {
          await firebaseSignOut(clientAuth());
          setState({
            user: null,
            loading: false,
            rejection: "هذا الحساب غير مُسجَّل في النظام. راجع مدير النظام.",
          });
          return;
        }

        const account = snapshot.data() as UserDoc;
        if (!account.active) {
          await firebaseSignOut(clientAuth());
          setState({
            user: null,
            loading: false,
            rejection: "هذا الحساب موقوف. راجع مدير النظام.",
          });
          return;
        }

        // A role the domain layer does not recognise grants nothing. Failing
        // closed is the only safe reading of a value it cannot interpret.
        if (!isRole(account.role)) {
          await firebaseSignOut(clientAuth());
          setState({
            user: null,
            loading: false,
            rejection: "صلاحية هذا الحساب غير معروفة. راجع مدير النظام.",
          });
          return;
        }

        setState({
          user: {
            uid: firebaseUser.uid,
            email: account.email,
            displayName: account.displayName,
            role: account.role,
            employeeNo: account.employeeNo ?? null,
          },
          loading: false,
          rejection: null,
        });
      } catch {
        // The read itself was refused, which the rules do for a session that
        // is no longer valid. Same outcome as not being signed in.
        setState({ user: null, loading: false, rejection: null });
      }
    });
  }, []);

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  return useContext(SessionContext);
}

/** The caller, or a redirect to the login page.
 *
 *  Returns null while the session is still being restored, which every page
 *  renders as its loading state rather than as "signed out".
 */
export function useRequireSession(): SessionUser | null {
  const { user, loading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  return user;
}

export async function signOut(): Promise<void> {
  await firebaseSignOut(clientAuth());
}
