import Link from 'next/link'

export default function Home() {
  return (
    <div className="landing">
      <div className="landing-box">
        <div className="landing-logo">habercikus</div>
        <div className="landing-sub">anlık sohbet odaları</div>
        <div className="landing-rooms">
          <Link href="/chat" className="room-link">
            <span className="room-name">#sohbet</span>
            <span className="room-desc">genel sohbet</span>
          </Link>
          <Link href="/haber" className="room-link">
            <span className="room-name">#haber</span>
            <span className="room-desc">haberler ve gündem</span>
          </Link>
        </div>
      </div>
    </div>
  )
}
