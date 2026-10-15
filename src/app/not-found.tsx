import { MarketingNavbar } from "@/components/marketing-navbar";
import { NotFoundView } from "@/components/not-found-view";

const NotFound = () => {
  return (
    <NotFoundView
      header={<MarketingNavbar />}
      title="Page not found"
      description="The page you're looking for doesn't exist or has moved."
    />
  );
};

export default NotFound;
