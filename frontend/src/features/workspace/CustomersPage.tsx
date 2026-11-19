import ResourcePage from './ResourcePage'

export default function CustomersPage() {
  return <ResourcePage
    title="Customers"
    section="Customer relationships"
    endpoint="/customers/"
    description="Keep a complete, useful record of the people and organizations you serve."
    fields={[
      { name: 'name', label: 'Contact name', required: true },
      { name: 'company', label: 'Company' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'phone', label: 'Phone' },
      { name: 'industry', label: 'Industry' },
      { name: 'health_score', label: 'Health score (0–100)', type: 'number' },
      { name: 'owner', label: 'Owner', type: 'select', optionsFrom: '/auth/team/', nullable: true },
    ]}
    columns={[
      { key: 'name', label: 'Contact' },
      { key: 'company', label: 'Company' },
      { key: 'email', label: 'Email' },
      { key: 'industry', label: 'Industry' },
      { key: 'health_score', label: 'Health score', badge: true },
      { key: 'owner_name', label: 'Owner' },
    ]}
  />
}
