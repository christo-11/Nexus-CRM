import ResourcePage from './ResourcePage'

export default function DealsPage() {
  return <ResourcePage
    title="Deals"
    section="Sales pipeline"
    endpoint="/deals/"
    description="Track opportunities, ownership, expected close dates, and deal stage."
    fields={[
      { name: 'name', label: 'Deal name', required: true },
      { name: 'customer', label: 'Customer', type: 'select', optionsFrom: '/customers/', required: true },
      { name: 'amount', label: 'Amount', type: 'number', required: true },
      { name: 'stage', label: 'Stage', type: 'select', required: true, options: [
        { value: 'QUALIFICATION', label: 'Qualification' },
        { value: 'NEEDS_ANALYSIS', label: 'Needs analysis' },
        { value: 'PROPOSAL', label: 'Proposal' },
        { value: 'NEGOTIATION', label: 'Negotiation' },
        { value: 'WON', label: 'Won' },
        { value: 'LOST', label: 'Lost' },
      ] },
      { name: 'expected_close_date', label: 'Expected close date', type: 'date' },
      { name: 'owner', label: 'Owner', type: 'select', optionsFrom: '/auth/team/', nullable: true },
    ]}
    columns={[
      { key: 'name', label: 'Opportunity' },
      { key: 'customer_name', label: 'Customer' },
      { key: 'amount', label: 'Amount', format: (value) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0)) },
      { key: 'stage', label: 'Stage', badge: true },
      { key: 'expected_close_date', label: 'Expected close' },
      { key: 'owner_name', label: 'Owner' },
    ]}
  />
}
