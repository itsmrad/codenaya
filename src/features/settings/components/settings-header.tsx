interface SettingsHeaderProps {
  title: string;
  description: string;
}

export const SettingsHeader = ({ title, description }: SettingsHeaderProps) => {
  return (
    <header className="space-y-2 pb-2 animate-in fade-in slide-in-from-bottom-2 duration-500 motion-reduce:animate-none">
      <h1 className="text-3xl font-semibold tracking-[-0.035em] text-foreground md:text-4xl">{title}</h1>
      <p className="text-[15px] text-muted-foreground">{description}</p>
    </header>
  );
};
