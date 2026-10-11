/** A settings block: what it is on the left, the controls on the right (stacked on phones). */
export function FormSection({
  title,
  description,
  children,
}: {
  title: string
  description: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="grid gap-4 md:grid-cols-[14rem_1fr] md:gap-8">
      <div>
        <h2 className="font-medium">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}
