import { CardDescription, CardTitle } from "@panel/components/ui/card";

export function PageLayout({ title, description, actions = null, children }) {
  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle className="text-2xl">{title}</CardTitle>
          <CardDescription className="max-w-5xl leading-6">{description}</CardDescription>
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}
