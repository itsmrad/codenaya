const ProjectLayout = ({ children }: { children: React.ReactNode }) => {
  // This route segment must always render its child. Authentication belongs in
  // the page so Next.js can validate the complete instant-navigation tree.
  return children;
};

export default ProjectLayout;
