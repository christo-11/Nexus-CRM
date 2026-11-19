import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js'
import type { ChartData, ChartOptions } from 'chart.js'
import { Bar, Doughnut, Line } from 'react-chartjs-2'

ChartJS.register(ArcElement, BarElement, CategoryScale, Filler, Legend, LinearScale, LineElement, PointElement, Tooltip)

type ChartProps =
  | { type: 'bar'; data: ChartData<'bar'>; options: ChartOptions<'bar'> }
  | { type: 'doughnut'; data: ChartData<'doughnut'>; options: ChartOptions<'doughnut'> }
  | { type: 'line'; data: ChartData<'line'>; options: ChartOptions<'line'> }

export default function AdminDashboardChart(props: ChartProps) {
  if (props.type === 'bar') return <Bar data={props.data} options={props.options} />
  if (props.type === 'doughnut') return <Doughnut data={props.data} options={props.options} />
  return <Line data={props.data} options={props.options} />
}
