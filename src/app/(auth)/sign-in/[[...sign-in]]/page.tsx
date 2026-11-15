import type { Metadata } from "next";
import { SignIn } from "@clerk/nextjs";

export const metadata: Metadata = { title: "Log in — Codenaya" };

const SignInPage = () => {
  return <SignIn />;
};

export default SignInPage;
