import ResourcePage from './ResourcePage'

export default function SupportPage() {
  return <ResourcePage
    title="Support tickets"
    section="Customer care"
    endpoint="/tickets/"
    description="Triage requests, assign support owners, and keep customers informed."
    fields={[
      { name: 'subject', label: 'Subject', required: true },
      { name: 'description', label: 'Description', type: 'textarea' },
      { name: 'customer', label: 'Customer', type: 'select', optionsFrom: '/customers/', required: true },
      { name: 'priority', label: 'Priority', type: 'select', required: true, options: [
        { value: 'LOW', label: 'Low' },
        { value: 'MEDIUM', label: 'Medium' },
        { value: 'HIGH', label: 'High' },
        { value: 'URGENT', label: 'Urgent' },
      ] },
      { name: 'status', label: 'Status', type: 'select', required: true, options: [
        { value: 'OPEN', label: 'Open' },
        { value: 'IN_PROGRESS', label: 'In progress' },
        { value: 'WAITING', label: 'Waiting' },
        { value: 'RESOLVED', label: 'Resolved' },
        { value: 'CLOSED', label: 'Closed' },
      ] },
      { name: 'assignee', label: 'Assignee', type: 'select', optionsFrom: '/auth/team/', nullable: true },
    ]}
    columns={[
      { key: 'subject', label: 'Ticket' },
      { key: 'customer_name', label: 'Customer' },
      { key: 'priority', label: 'Priority', badge: true },
      { key: 'status', label: 'Status' },
      { key: 'assignee_name', label: 'Assignee' },
      { key: 'created_at', label: 'Created' },
    ]}
  />
}
