/**
 * Official starter templates (#119). Each one creates a project seeded with a
 * small Vite + React + Tailwind app (see `seed-files.ts`) and starts the agent
 * on a curated prompt that builds the template on top of it.
 *
 * Plain data, shared by the dashboard, /showcase and the create route, so the
 * server only seeds templates it knows.
 */
export const STARTER_TEMPLATES = [
  {
    id: "landing-page",
    title: "Landing page",
    description: "Hero, feature highlights, pricing table, FAQ and a sign-up call to action.",
    techStack: ["React", "Vite", "Tailwind"],
    prompt:
      "Build a SaaS landing page for a product called Lumen: a sticky navbar, a hero with a headline, subheading and two call-to-action buttons, a three-column feature grid with lucide icons, a pricing table with three tiers and a monthly/yearly toggle, an FAQ accordion, a newsletter sign-up form with validation and a footer. Make it fully responsive with light and dark mode.",
  },
  {
    id: "saas-dashboard",
    title: "SaaS dashboard",
    description: "Sidebar layout with KPI cards, a revenue chart and a recent orders table.",
    techStack: ["React", "Vite", "Tailwind", "Recharts"],
    prompt:
      "Build a SaaS analytics dashboard: a collapsible sidebar with navigation, a top bar with search and a user menu, four KPI cards (revenue, users, conversion, churn) with trend badges, a revenue line chart and a signups bar chart using recharts, and a sortable, paginated recent orders table with status badges. Use realistic mock data, make the sidebar a drawer on phones, and support light and dark mode.",
  },
  {
    id: "portfolio",
    title: "Portfolio",
    description: "Personal site with an about section, project grid and contact form.",
    techStack: ["React", "Vite", "Tailwind"],
    prompt:
      "Build a personal portfolio site for a product designer: a hero with name, role and social links, an about section with a short bio and skills, a filterable projects grid with cards that open a detail modal, an experience timeline, and a contact form with validation that shows a success toast. Make it fully responsive with light and dark mode.",
  },
  {
    id: "blog",
    title: "Blog",
    description: "Post list with tags and search, plus readable article pages.",
    techStack: ["React", "Vite", "Tailwind", "React Router"],
    prompt:
      "Build a blog with react-router-dom: a home page listing posts as cards with cover, title, excerpt, author, date and tags, a search box and tag filters, an article page with comfortable typography, reading time and a table of contents, and an about page. Store posts as local mock data. Make it fully responsive with light and dark mode.",
  },
  {
    id: "ecommerce-storefront",
    title: "E-commerce storefront",
    description: "Product catalog with filters, product pages and a working cart.",
    techStack: ["React", "Vite", "Tailwind", "React Router"],
    prompt:
      "Build an e-commerce storefront with react-router-dom: a catalog page with a product grid, category and price filters and sorting, a product detail page with an image gallery, size selector and add-to-cart, a slide-over cart with quantity controls and a subtotal persisted in localStorage, and a checkout form with validation. Use realistic mock products. Make it fully responsive with light and dark mode.",
  },
  {
    id: "admin-crud",
    title: "Admin CRUD",
    description: "Manage records in a searchable table with create, edit and delete dialogs.",
    techStack: ["React", "Vite", "Tailwind"],
    prompt:
      "Build an admin panel for managing customers: a sidebar layout, a searchable, sortable and paginated table of customers (name, email, plan, status, created date), a create/edit dialog with a validated form, a delete confirmation dialog, bulk select with bulk delete, and empty and loading states. Keep the data in local state seeded with mock records and persist it to localStorage. Make it fully responsive with light and dark mode.",
  },
] as const;

export type StarterTemplate = (typeof STARTER_TEMPLATES)[number];
export type StarterTemplateId = StarterTemplate["id"];

export const STARTER_TEMPLATE_IDS = STARTER_TEMPLATES.map((t) => t.id) as [
  StarterTemplateId,
  ...StarterTemplateId[],
];

export const getStarterTemplate = (id: string): StarterTemplate | undefined =>
  STARTER_TEMPLATES.find((t) => t.id === id);
