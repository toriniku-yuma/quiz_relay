export default function UserScopeSelect({
  value,
  instances,
  onChange,
  disabled = false,
  organizationLabel = '組織全体',
  allowOrganization = true,
}: {
  value: string | null;
  instances: { id: string; name: string }[];
  onChange: (value: string | null) => void;
  disabled?: boolean;
  organizationLabel?: string;
  allowOrganization?: boolean;
}) {
  return (
    <label className="grid gap-2">
      操作対象
      <select
        className="h-12 border border-line bg-input p-2"
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="" disabled={!allowOrganization}>
          {organizationLabel}
        </option>
        {instances.map((instance) => (
          <option key={instance.id} value={instance.id}>
            {instance.name}
          </option>
        ))}
      </select>
    </label>
  );
}
