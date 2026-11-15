import type { Metadata } from "next";
import { SignUp } from "@clerk/nextjs";

export const metadata: Metadata = { title: "Sign up — Codenaya" };

const SignUpPage = () => {
  return <SignUp />;
};

export default SignUpPage;
