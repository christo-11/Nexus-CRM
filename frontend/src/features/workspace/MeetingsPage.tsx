import ResourcePage from './ResourcePage'

export default function MeetingsPage() {
  return <ResourcePage
    title="Meetings"
    section="Team collaboration"
    endpoint="/meetings/"
    description="Schedule customer conversations and link them to deals."
    fields={[
      { name: 'title', label: 'Meeting title', required: true },
      { name: 'starts_at', label: 'Start date and time', type: 'datetime-local', required: true },
      { name: 'duration_minutes', label: 'Duration (minutes)', type: 'number', required: true },
      { name: 'customer', label: 'Customer', type: 'select', optionsFrom: '/customers/', nullable: true },
      { name: 'deal', label: 'Deal', type: 'select', optionsFrom: '/deals/', nullable: true },
      { name: 'host', label: 'Host', type: 'select', optionsFrom: '/auth/team/', nullable: true },
      { name: 'status', label: 'Status', type: 'select', required: true, options: [
        { value: 'SCHEDULED', label: 'Scheduled' },
        { value: 'COMPLETED', label: 'Completed' },
        { value: 'CANCELED', label: 'Canceled' },
      ] },
      { name: 'meeting_url', label: 'Meeting link' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ]}
    columns={[
      { key: 'title', label: 'Meeting' },
      { key: 'customer_name', label: 'Customer' },
      { key: 'starts_at', label: 'Starts' },
      { key: 'duration_minutes', label: 'Minutes' },
      { key: 'status', label: 'Status', badge: true },
      { key: 'host_name', label: 'Host' },
    ]}
  />
}
